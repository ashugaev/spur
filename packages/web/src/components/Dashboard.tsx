"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AttentionZone } from "@/components/AttentionZone";
import { DataRow, RowIconButton } from "@/components/DataRow";
import { Zone } from "@/components/Zone";
import { StatusBar } from "@/components/StatusBar";
import { EmptyState } from "@/components/EmptyState";
import { CloseIcon } from "@/components/icons/CloseIcon";
import { OpenPrActionDialog } from "@/components/OpenPrActionDialog";
import { SpawnModal } from "@/components/SpawnModal";
import { FileAttachmentTextarea } from "@/components/FileAttachmentTextarea";
import { InputHistoryButton } from "@/components/InputHistory";
import { SlashSuggestions } from "@/components/SlashSuggestions";
import { TerminalModal } from "@/components/TerminalModal";
import { ToastViewport } from "@/components/Toast";
import { VoiceControls, VoiceStatusHint, voicePlaceholder } from "@/components/VoiceInput";
import { INPUT_CLASS } from "@/design/classes";
import { insertTextAtCursor } from "@/lib/textarea";
import { useFooterPopover } from "@/lib/footer-popover";
import { useInputHistory } from "@/hooks/useInputHistory";
import { MOBILE_BREAKPOINT, useMediaQuery } from "@/hooks/useMediaQuery";
import { useToasts } from "@/hooks/useToasts";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { errorMessage, readResponsePayload, responseErrorMessage } from "@/lib/json-payload";
import {
  encodeFileAttachments,
  fileAttachmentsFromFiles,
  type FileAttachment,
} from "@/lib/file-attachments";
import { JiraIcon } from "@/lib/link-icons";
import { getTerminalQuerySessionId, withTerminalQuery } from "@/lib/project-routes";
import { normalizeBranchName } from "@/lib/branch-name";
import type { AgentName } from "@/lib/agents";
import { isVoiceToggleHotkey } from "@/lib/submit-hotkeys";
import {
  ATTENTION_ZONE_ORDER,
  collapseDeskRows,
  isOpenPrActionRequiredPayload,
  isTerminalSession,
  toDashboardSession,
  type AttentionLevel,
  type AvailableBacklogItem,
  type BranchExistsResponse,
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
  type TakeBacklogItemResponse,
  type UpdateProjectRequest,
  type UpdateProjectResponse,
} from "@/lib/types";
import { TagsContext, type TagChange } from "@/components/TagsContext";
import { TagFilter } from "@/components/TagFilter";
import { useVersionSwitch } from "@/lib/version-switch-context";
import { useTagCatalog } from "@/hooks/useTagCatalog";

const SESSIONS_POLL_INTERVAL_MS = 5_000;
const LANE_ORDER_SET: ReadonlySet<string> = new Set(ATTENTION_ZONE_ORDER);
const DEFAULT_COLLAPSED_MOBILE_CATEGORIES: AttentionLevel[] = ["stopped"];
const LAST_SPAWN_PROJECT_STORAGE_KEY = "spur:last-spawn-project";
const TAG_FILTERS_STORAGE_KEY = "spur:tag-filters";
const LEGACY_TAG_FILTER_STORAGE_KEY = "spur:tag-filter";
const DASHBOARD_SEARCH_TOOL_BUTTON_CLASS =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center bg-transparent text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)]";
const COLLAPSED_CATEGORIES_STORAGE_KEY = "spur:mobile-collapsed-categories";
const SPAWN_PROMPT_HISTORY_STORAGE_KEY = "spur:input-history:spawn-prompt";
const BABYSITTER_PROMPT_HISTORY_STORAGE_KEY = "spur:input-history:spawn-babysitter-prompt";
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

function sameDeskActiveSessions(
  sessions: readonly DashboardSession[],
  session: DashboardSession,
): DashboardSession[] {
  return sessions.filter(
    (candidate) =>
      candidate.deskKey === session.deskKey &&
      candidate.status !== "killed" &&
      candidate.status !== "completed",
  );
}

function completedIdsFromResponse(value: unknown): string[] {
  if (typeof value !== "object" || value === null || !("completedIds" in value)) return [];
  const completedIds = (value as { completedIds?: unknown }).completedIds;
  if (!Array.isArray(completedIds)) return [];
  return completedIds.filter((id): id is string => typeof id === "string");
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

function BacklogZone({
  items,
  projectNameMap,
  takingKey,
  onTake,
}: {
  items: readonly AvailableBacklogItem[];
  projectNameMap: Map<string, string>;
  takingKey: string | null;
  onTake: (item: AvailableBacklogItem) => Promise<void>;
}) {
  if (items.length === 0) return null;
  return (
    <Zone label="Backlog" color="var(--color-status-attention)" count={items.length}>
      {items.map((item) => {
        const itemKey = `${item.projectId}:${item.backlogId}:${item.externalId}`;
        return (
          <DataRow key={itemKey}>
            <a
              className="flex min-w-0 flex-1 items-center gap-2 truncate text-[var(--color-text-secondary)] transition hover:text-[var(--color-text-primary)] hover:no-underline"
              href={item.url}
              rel="noreferrer"
              target="_blank"
            >
              <span
                aria-label={BACKLOG_PROVIDER_LABELS[item.provider]}
                className="flex shrink-0 items-center text-[var(--color-text-tertiary)]"
                role="img"
                title={BACKLOG_PROVIDER_LABELS[item.provider]}
              >
                {BACKLOG_PROVIDER_ICONS[item.provider]}
              </span>
              <span className="shrink-0 font-semibold uppercase text-[var(--color-text-primary)]">
                {item.key}
              </span>
              <span className="min-w-0 truncate">{item.title}</span>
            </a>
            <span className="hidden w-[7rem] shrink-0 truncate text-right text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)] sm:inline">
              {projectNameMap.get(item.projectId) ?? item.projectId}
            </span>
            <RowIconButton
              activeClass="border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              disabled={takingKey !== null}
              label="Take task"
              onClick={() => void onTake(item)}
            >
              <span className={takingKey === itemKey ? "animate-pulse" : undefined}>
                <IconTake />
              </span>
            </RowIconButton>
          </DataRow>
        );
      })}
    </Zone>
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
function IconAlert() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
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
function IconGauge() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m12 14 4-4" />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
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

function IconEdit() {
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
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
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

function IconTake() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

const BACKLOG_PROVIDER_ICONS: Record<AvailableBacklogItem["provider"], React.ReactNode> = {
  jira: <JiraIcon />,
};

const BACKLOG_PROVIDER_LABELS: Record<AvailableBacklogItem["provider"], string> = {
  jira: "Jira",
};

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

function sortProjects(left: ProjectInfo, right: ProjectInfo): number {
  if (left.kind === "shepherd") return -1;
  if (right.kind === "shepherd") return 1;
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
}

function ProjectMenu({
  activeProjectName,
  projects,
  selectedProjectId,
  onSelectProject,
  onNewProject,
  onEdit,
}: {
  activeProjectName: string;
  projects: ProjectInfo[];
  selectedProjectId: string;
  onSelectProject: (projectId: string) => void;
  onNewProject: () => void;
  onEdit: (project: ProjectInfo) => void;
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
        aria-haspopup="menu"
        aria-label={`Project filter: ${activeProjectName}`}
        className="inline-flex min-w-0 max-w-full items-center gap-3 text-[var(--color-text-primary)] transition hover:text-[var(--color-accent)]"
        type="button"
        onClick={popover.toggle}
      >
        <span className="text-xl text-[var(--color-accent)]">𖤓</span>
        <span className="inline-flex min-w-0 max-w-full items-center gap-1 text-xl font-bold uppercase tracking-[-0.02em] sm:text-2xl">
          <span className="block min-w-0 truncate">{activeProjectName}</span>
          <svg
            aria-hidden="true"
            data-testid="project-filter-chevron"
            className="pointer-events-none mt-px h-4 w-4 shrink-0"
            fill="currentColor"
            viewBox="0 0 16 16"
          >
            <path d="M4 6.5 8 10.5 12 6.5Z" />
          </svg>
        </span>
      </button>
      {popover.open ? (
        <div
          className="absolute left-0 top-full z-50 mt-1 min-w-[260px] max-w-[calc(100vw-1rem)] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-2 shadow-[0_4px_12px_var(--color-shadow-modal-sm)]"
          role="menu"
        >
          <button
            aria-checked={selectedProjectId === ""}
            className={`mb-1 flex w-full items-center gap-2 border px-2 py-1.5 text-left font-bold uppercase transition hover:border-[var(--color-accent)] hover:bg-[var(--color-accent)]/20 hover:text-[var(--color-accent)] ${selectedProjectId === "" ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25" : "border-transparent text-[var(--color-text-primary)]"}`}
            onClick={() => {
              popover.dismiss();
              onSelectProject("");
            }}
            role="menuitemradio"
            type="button"
          >
            <span aria-hidden="true" className="w-3 text-center">
              {selectedProjectId === "" ? "✓" : ""}
            </span>
            <span>All Projects</span>
          </button>
          {projects.length === 0 ? (
            <p className="px-2 py-1.5 text-[var(--color-text-tertiary)]">No projects yet.</p>
          ) : (
            <ul className="flex flex-col" role="group">
              {projects.map((project) => (
                <li
                  key={project.id}
                  role="none"
                  className="group flex items-center gap-2 border-t border-[var(--color-border-subtle)] py-1.5 transition hover:bg-[var(--color-accent)]/10"
                >
                  {project.configured ? (
                    <button
                      aria-checked={selectedProjectId === project.id}
                      className={`flex min-w-0 flex-1 items-center gap-2 border px-2 py-1.5 text-left transition hover:border-[var(--color-accent)] hover:bg-[var(--color-accent)]/20 hover:text-[var(--color-accent)] ${selectedProjectId === project.id ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25" : "border-transparent text-[var(--color-text-primary)]"}`}
                      onClick={() => {
                        popover.dismiss();
                        onSelectProject(project.id);
                      }}
                      role="menuitemradio"
                      type="button"
                    >
                      <span aria-hidden="true" className="w-3 shrink-0 text-center">
                        {selectedProjectId === project.id ? "✓" : ""}
                      </span>
                      <span className="min-w-0 truncate">{project.name}</span>
                      {project.kind === "shepherd" ? (
                        <span className="shrink-0 border border-[var(--color-border-default)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--color-text-tertiary)]">
                          built-in
                        </span>
                      ) : null}
                    </button>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">
                      {project.name}
                    </span>
                  )}
                  {project.kind === "shepherd" && !project.configured ? (
                    <span className="border border-[var(--color-border-default)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--color-text-tertiary)]">
                      built-in
                    </span>
                  ) : null}
                  {!project.configured ? (
                    <span className="border border-[var(--color-border-default)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--color-text-tertiary)]">
                      unconfigured
                    </span>
                  ) : null}
                  <button
                    aria-label={`Edit ${project.name}`}
                    className="border border-transparent px-1.5 py-1 text-[var(--color-text-tertiary)] transition group-hover:border-[var(--color-border-subtle)] group-hover:bg-[var(--color-accent)]/15 hover:border-[var(--color-border-strong)] hover:bg-[var(--color-accent)]/20 hover:text-[var(--color-accent)]"
                    onClick={() => {
                      popover.dismiss();
                      onEdit(project);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <IconEdit />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            className="mt-2 w-full bg-[var(--color-accent)] px-2 py-1.5 text-left font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)]"
            onClick={() => {
              popover.dismiss();
              onNewProject();
            }}
            role="menuitem"
            type="button"
          >
            + New project
          </button>
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
            className="mb-3 flex flex-col gap-2 border border-[var(--color-status-attention)] bg-[var(--color-status-attention)]/10 px-2.5 py-1.5 text-[var(--color-status-attention)]"
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

function EditProjectModal({
  project,
  displayName,
  prefix,
  path,
  error,
  submitting,
  deleting,
  onDisplayNameChange,
  onPrefixChange,
  onPathChange,
  onSubmit,
  onDelete,
  onClose,
}: {
  project: ProjectInfo;
  displayName: string;
  prefix: string;
  path: string;
  error: string | null;
  submitting: boolean;
  deleting: boolean;
  onDisplayNameChange: (value: string) => void;
  onPrefixChange: (value: string) => void;
  onPathChange: (value: string) => void;
  onSubmit: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const editable = !project.configured && project.kind !== "shepherd";
  const deletable = project.kind !== "shepherd";
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const deleteLabel = project.configured ? "Disconnect" : "Delete";

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (confirmDeleteOpen) {
          setConfirmDeleteOpen(false);
          return;
        }
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [confirmDeleteOpen, onClose]);

  useEffect(() => {
    setConfirmDeleteOpen(false);
  }, [project.id]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-modal-backdrop)]"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        aria-labelledby="edit-project-title"
        aria-modal="true"
        className="flex w-full max-h-[calc(100vh-1rem)] flex-col overflow-hidden border border-[var(--color-border-default)] bg-[var(--color-bg-base)] p-4 shadow-[0_20px_60px_var(--color-shadow-modal-lg)] sm:max-h-[calc(100vh-2rem)] sm:w-full sm:max-w-md sm:p-5"
        role="dialog"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2
            className="text-sm font-bold uppercase tracking-[0.1em] text-[var(--color-text-primary)]"
            id="edit-project-title"
          >
            Project settings
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
            aria-label="Edit project display name"
            className={INPUT_CLASS}
            disabled={!editable}
            onChange={(event) => onDisplayNameChange(event.target.value)}
            value={displayName}
          />
        </label>
        <label className="mb-3 flex flex-col gap-1">
          <span className="text-[var(--color-text-secondary)]">Session prefix</span>
          <input
            aria-label="Edit project session prefix"
            className={INPUT_CLASS}
            disabled={!editable}
            onChange={(event) => onPrefixChange(event.target.value)}
            value={prefix}
          />
        </label>
        <label className="mb-3 flex flex-col gap-1">
          <span className="text-[var(--color-text-secondary)]">Project path</span>
          <input
            aria-label="Edit project path"
            className={INPUT_CLASS}
            disabled={!editable}
            onChange={(event) => onPathChange(event.target.value)}
            value={path}
          />
        </label>
        {project.configured ? (
          <p className="mb-3 text-[var(--color-text-tertiary)]">
            Configured projects are edited in spur.yaml.
          </p>
        ) : null}
        {project.kind === "shepherd" ? (
          <p className="mb-3 text-[var(--color-text-tertiary)]">
            Shepherd is built in and cannot be edited or deleted.
          </p>
        ) : null}
        {error ? <p className="mb-3 text-[var(--color-status-error)]">{error}</p> : null}
        {confirmDeleteOpen ? (
          <div
            className="mb-3 flex flex-col gap-2 border border-[var(--color-status-error)] bg-[var(--color-status-error)]/10 px-2.5 py-1.5 text-[var(--color-status-error)]"
            role="alert"
          >
            <span>
              {project.configured
                ? `Disconnect ${project.name}? Spur will stop tracking its spur.yaml.`
                : `Delete ${project.name}?`}
            </span>
            <div className="flex flex-wrap gap-2">
              <button
                className="border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-secondary)] transition hover:text-[var(--color-text-primary)]"
                disabled={deleting}
                onClick={() => setConfirmDeleteOpen(false)}
                type="button"
              >
                Cancel {deleteLabel}
              </button>
              <button
                className="inline-flex items-center gap-1.5 border border-[var(--color-status-error)] px-3 py-1.5 font-bold uppercase text-[var(--color-status-error)] transition hover:bg-[var(--color-bg-surface)] disabled:cursor-not-allowed disabled:opacity-60"
                disabled={deleting}
                onClick={onDelete}
                type="button"
              >
                <IconTrash />
                {deleting ? "Deleting…" : `Confirm ${deleteLabel}`}
              </button>
            </div>
          </div>
        ) : null}
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-2">
          {deletable ? (
            <button
              className="inline-flex items-center gap-1.5 border border-[var(--color-status-error)] px-3 py-1.5 font-bold uppercase text-[var(--color-status-error)] transition hover:bg-[var(--color-bg-surface)] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={deleting || confirmDeleteOpen}
              onClick={() => setConfirmDeleteOpen(true)}
              type="button"
            >
              <IconTrash />
              {deleteLabel}
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              className="border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-secondary)] transition hover:text-[var(--color-text-primary)]"
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
            {editable ? (
              <button
                className="bg-[var(--color-accent)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                disabled={submitting}
                onClick={onSubmit}
                type="button"
              >
                {submitting ? "Saving…" : "Save"}
              </button>
            ) : null}
          </div>
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
  const { toasts, showErrorToast, dismissToast } = useToasts();
  const [openPrAction, setOpenPrAction] = useState<{
    session: DashboardSession;
    payload: OpenPrActionRequiredPayload;
  } | null>(null);
  const [openPrActionBusy, setOpenPrActionBusy] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [spawnProjectId, setSpawnProjectId] = useState("");
  const [spawnPinnedProjectId, setSpawnPinnedProjectId] = useState<string | null>(null);
  const [spawnPrompt, setSpawnPrompt] = useState("");
  const [spawnAgent, setSpawnAgent] = useState<AgentName>("claude");
  const [spawnModel, setSpawnModel] = useState<string | null>(null);
  const [spawnBranch, setSpawnBranch] = useState("");
  const [branchExists, setBranchExists] = useState<BranchExistsResponse | null>(null);
  const [spawnPlanMode, setSpawnPlanMode] = useState(false);
  const [spawnSelfDestruct, setSpawnSelfDestruct] = useState(false);
  const [spawnSelfDestructConditions, setSpawnSelfDestructConditions] = useState("");
  const [spawnSteps, setSpawnSteps] = useState<{ id: number; value: string }[]>([]);
  const [spawnWorkspaceMode, setSpawnWorkspaceMode] = useState<"default" | "worktree" | "shared">(
    "default",
  );
  const [spawnDefaultBranch, setSpawnDefaultBranch] = useState("");
  const [spawnAttachments, setSpawnAttachments] = useState<FileAttachment[]>([]);
  const [spawnBabysitterEnabled, setSpawnBabysitterEnabled] = useState(false);
  const [babysitterPrompt, setBabysitterPrompt] = useState("");
  const [babysitterPromptTouched, setBabysitterPromptTouched] = useState(false);
  const [babysitterAttachments, setBabysitterAttachments] = useState<FileAttachment[]>([]);
  const [pendingBabysitterFor, setPendingBabysitterFor] = useState<string | null>(null);
  const babysitterPromptRef = useRef<HTMLTextAreaElement>(null);
  const babysitterHistory = useInputHistory(BABYSITTER_PROMPT_HISTORY_STORAGE_KEY);
  const babysitterVoice = useVoiceInput({
    contextKey: "spawn-babysitter",
    onTranscribed: (text) =>
      setBabysitterPrompt((current) => (current.trim() ? `${current}\n${text}` : text)),
  });
  const [spawning, setSpawning] = useState(false);
  const spawningRef = useRef(false);
  const [takingBacklogKey, setTakingBacklogKey] = useState<string | null>(null);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const spawnPromptRef = useRef<HTMLTextAreaElement>(null);
  const spawnHistory = useInputHistory(SPAWN_PROMPT_HISTORY_STORAGE_KEY);
  const voice = useVoiceInput({
    contextKey: "spawn",
    onTranscribed: (text) =>
      setSpawnPrompt((current) => (current.trim() ? `${current}\n${text}` : text)),
  });
  const searchVoice = useVoiceInput({
    contextKey: "dashboard-search",
    onTranscribed: setSearchQuery,
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
  const [activeTagFilters, setActiveTagFilters] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    const stored = window.localStorage.getItem(TAG_FILTERS_STORAGE_KEY);
    if (stored) {
      try {
        const parsed: unknown = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          const tags = parsed
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
          if (tags.length > 0) return tags;
        }
      } catch {
        // Corrupt JSON — fall through to the legacy key below.
      }
    }
    // Reached when the new key is absent, empty, or invalid: a still-valid
    // legacy single-tag value must not be lost before its one-time migration.
    const legacy = window.localStorage.getItem(LEGACY_TAG_FILTER_STORAGE_KEY)?.trim();
    return legacy ? [legacy] : [];
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (activeTagFilters.length > 0) {
      window.localStorage.setItem(TAG_FILTERS_STORAGE_KEY, JSON.stringify(activeTagFilters));
    } else {
      window.localStorage.removeItem(TAG_FILTERS_STORAGE_KEY);
    }
  }, [activeTagFilters]);
  // One-time migration cleanup: the legacy single-tag key is read once in the
  // initializer above, then dropped on mount so it never lingers.
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(LEGACY_TAG_FILTER_STORAGE_KEY);
  }, []);
  const toggleStatFilter = (level: AttentionLevel) =>
    setActiveStatFilter((current) => (current === level ? null : level));
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectDisplayName, setNewProjectDisplayName] = useState("");
  const [newProjectPrefix, setNewProjectPrefix] = useState("");
  const [newProjectPath, setNewProjectPath] = useState("");
  const [newProjectError, setNewProjectError] = useState<string | null>(null);
  const [newProjectMissingPath, setNewProjectMissingPath] = useState<string | null>(null);
  const [newProjectSubmitting, setNewProjectSubmitting] = useState(false);
  const [editingProject, setEditingProject] = useState<ProjectInfo | null>(null);
  const [editProjectDisplayName, setEditProjectDisplayName] = useState("");
  const [editProjectPrefix, setEditProjectPrefix] = useState("");
  const [editProjectPath, setEditProjectPath] = useState("");
  const [editProjectError, setEditProjectError] = useState<string | null>(null);
  const [editProjectSubmitting, setEditProjectSubmitting] = useState(false);
  const [editProjectDeleting, setEditProjectDeleting] = useState(false);
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
  const availableBacklog = data?.backlog ?? [];
  const projects = data?.projects ?? [];
  // Single shared catalog source (react-query key ["tag-catalog"]) so the
  // dashboard dots popover and the detail chips popover dedupe on one cache.
  const tagCatalog = useTagCatalog();
  // Self-heal the persisted filter: once the catalog loads, drop any selected
  // tag that no longer exists in it (deleted tag or corrupted localStorage),
  // so a stale entry can't keep the trigger active with no way to uncheck it.
  useEffect(() => {
    if (tagCatalog.length === 0) return;
    const known = new Set(tagCatalog.map((tag) => tag.name));
    setActiveTagFilters((current) => {
      const pruned = current.filter((name) => known.has(name));
      return pruned.length === current.length ? current : pruned;
    });
  }, [tagCatalog]);
  const loading = isPending;
  const sessionsErrorToastRef = useRef<{ id: number; message: string } | null>(null);
  const { phase: versionSwitchPhase } = useVersionSwitch();

  useEffect(() => {
    if (!sessionsError) {
      const current = sessionsErrorToastRef.current;
      if (current) {
        dismissToast(current.id);
        sessionsErrorToastRef.current = null;
      }
      return;
    }
    // The daemon is expected to be unreachable while a version switch is in
    // flight — don't surface that as a new session-load error toast, and
    // clear any pre-existing one so it doesn't linger behind the overlay.
    if (versionSwitchPhase === "switching" || versionSwitchPhase === "done") {
      const current = sessionsErrorToastRef.current;
      if (current) {
        dismissToast(current.id);
        sessionsErrorToastRef.current = null;
      }
      return;
    }
    const message = errorMessage(sessionsError, "Failed to load Spur sessions");
    const current = sessionsErrorToastRef.current;
    if (current?.message === message) return;
    if (current) {
      dismissToast(current.id);
    }
    const id = showErrorToast(message);
    sessionsErrorToastRef.current = { id, message };
  }, [dismissToast, sessionsError, showErrorToast, versionSwitchPhase]);

  const filterProjectOptions = useMemo(() => [...projects].sort(sortProjects), [projects]);

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

  // Only surface tags in the filter that are actually applied to sessions in
  // the current project scope; an unused configured tag would just filter to
  // nothing, so it should not appear as an option at all.
  const filterTagCatalog = useMemo(() => {
    const present = new Set(projectSessions.flatMap((session) => session.tags));
    return tagCatalog.filter((tag) => present.has(tag.name));
  }, [projectSessions, tagCatalog]);

  const tagFilteredSessions = useMemo(() => {
    if (activeTagFilters.length === 0) return projectSessions;
    const keys = new Set(
      projectSessions
        .filter((s) => activeTagFilters.some((t) => s.tags.includes(t)))
        .map((s) => s.deskKey),
    );
    return projectSessions.filter((s) => keys.has(s.deskKey));
  }, [projectSessions, activeTagFilters]);

  const sessions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return tagFilteredSessions;
    const narrowed = tagFilteredSessions.filter(
      (s) =>
        s.id.toLowerCase().includes(q) ||
        (s.title ?? "").toLowerCase().includes(q) ||
        s.prompt.toLowerCase().includes(q) ||
        s.projectName.toLowerCase().includes(q) ||
        (s.branch ?? "").toLowerCase().includes(q),
    );
    const keys = new Set(narrowed.map((s) => s.deskKey));
    return tagFilteredSessions.filter((s) => keys.has(s.deskKey));
  }, [tagFilteredSessions, searchQuery]);

  const visibleBacklog = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return availableBacklog.filter((item) => {
      if (projectId && item.projectId !== projectId) return false;
      if (!q) return true;
      return (
        item.key.toLowerCase().includes(q) ||
        item.title.toLowerCase().includes(q) ||
        item.projectId.toLowerCase().includes(q)
      );
    });
  }, [availableBacklog, projectId, searchQuery]);

  const deskCollapsedRows = useMemo(() => collapseDeskRows(sessions), [sessions]);

  const grouped = useMemo(() => {
    const lanes: Record<AttentionLevel, DeskCollapsedRow[]> = {
      error: [],
      rate_limited: [],
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
      error: grouped.error.length,
      rate_limited: grouped.rate_limited.length,
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
    projectId.length > 0 ||
    searchQuery.trim().length > 0 ||
    activeStatFilter !== null ||
    activeTagFilters.length > 0;
  const hasVisibleSessions = visibleLevels.length > 0;
  const hasVisibleBacklog = activeStatFilter === null && visibleBacklog.length > 0;
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

  const normalizedBranchPreview = useMemo(() => normalizeBranchName(spawnBranch), [spawnBranch]);

  useEffect(() => {
    // Clear any prior result immediately so a stale hint never lingers against
    // a different name while the debounce + request for the new name is pending.
    setBranchExists(null);
    const project = spawnProjectId.trim();
    if (!project || !normalizedBranchPreview) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(
        `/api/projects/${encodeURIComponent(project)}/branches/exists?name=${encodeURIComponent(normalizedBranchPreview)}`,
        { signal: controller.signal },
      )
        .then((r) => (r.ok ? r.json() : null))
        .then((result: BranchExistsResponse | null) => {
          if (result) setBranchExists(result);
        })
        .catch(() => {});
    }, 300);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [spawnProjectId, normalizedBranchPreview]);

  const babysitterPromptMissing = spawnBabysitterEnabled && !babysitterPrompt.trim();

  const insertSpawnedSession = (session: SpurSessionView) => {
    queryClient.setQueryData<SpurSessionsResponse>(sessionsQueryKey, (current) => {
      const currentSessions = (current?.sessions ?? []).filter(
        (existingSession) => existingSession.id !== session.id,
      );
      return {
        ...(current ?? {}),
        sessions: [session, ...currentSessions],
        projects: current?.projects ?? [],
      };
    });
  };

  const resetBabysitterState = () => {
    setSpawnBabysitterEnabled(false);
    setBabysitterPrompt("");
    setBabysitterPromptTouched(false);
    setBabysitterAttachments([]);
    setPendingBabysitterFor(null);
  };

  // Spawns the babysitter against an existing primary. The primary body never
  // carries babysitterOf; only this second request does.
  const spawnBabysitter = async (primaryId: string, projectId: string) => {
    const payload: Record<string, unknown> = {
      projectId,
      prompt: babysitterPrompt.trim(),
      agent: spawnAgent,
      babysitterOf: primaryId,
    };
    const encoded = encodeFileAttachments(babysitterAttachments);
    if (encoded.length > 0) payload.attachments = encoded;

    const response = await fetch("/api/spawn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(await response.text());
    babysitterHistory.saveEntry(babysitterPrompt.trim());
    insertSpawnedSession((await response.json()) as SpurSessionView);
  };

  const handleSpawn = async () => {
    const nextProjectId = spawnProjectId.trim();
    const nextPrompt = spawnPrompt.trim();
    if (!nextProjectId || spawningRef.current) return;
    if (babysitterPromptMissing) {
      setBabysitterPromptTouched(true);
      return;
    }

    spawningRef.current = true;
    setSpawning(true);
    try {
      // Retry path: the primary already spawned last attempt; only the
      // babysitter is left, so skip the primary and target the existing id.
      if (pendingBabysitterFor) {
        await spawnBabysitter(pendingBabysitterFor, nextProjectId);
        resetBabysitterState();
        setSpawnPinnedProjectId(null);
        setSpawnOpen(false);
        syncSpawnProject(nextProjectId);
        return;
      }

      const filteredSteps = spawnSteps.map((s) => s.value.trim()).filter((s) => s.length > 0);
      const overrides = buildSpawnOverrides(spawnWorkspaceMode, spawnDefaultBranch);

      const payload: Record<string, unknown> = {
        projectId: nextProjectId,
        prompt: nextPrompt,
        agent: spawnAgent,
      };
      if (spawnModel !== null) payload.model = spawnModel;
      const encodedAttachments = encodeFileAttachments(spawnAttachments);
      if (encodedAttachments.length > 0) payload.attachments = encodedAttachments;
      const normalizedBranch = normalizeBranchName(spawnBranch);
      if (normalizedBranch) payload.branch = normalizedBranch;
      if (spawnPlanMode) payload.planMode = true;
      if (spawnSelfDestruct) {
        const conditions = spawnSelfDestructConditions.trim();
        payload.selfDestruct = {
          enabled: true,
          ...(conditions ? { conditions } : {}),
        };
      }
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
      insertSpawnedSession(session);
      setSpawnPrompt("");
      setSpawnModel(null);
      setSpawnBranch("");
      setSpawnPlanMode(false);
      setSpawnSelfDestruct(false);
      setSpawnSelfDestructConditions("");
      setSpawnSteps([]);
      setSpawnWorkspaceMode("default");
      setSpawnDefaultBranch("");
      setSpawnAttachments([]);

      // Primary succeeded. If a babysitter is requested, spawn it as a second
      // step; a babysitter-only failure keeps the modal open for retry.
      if (spawnBabysitterEnabled && babysitterPrompt.trim()) {
        try {
          await spawnBabysitter(session.id, nextProjectId);
          resetBabysitterState();
        } catch (babysitterError) {
          setPendingBabysitterFor(session.id);
          showErrorToast(
            "Babysitter spawn failed",
            errorMessage(babysitterError, "Failed to spawn babysitter"),
          );
          return;
        }
      }

      setSpawnPinnedProjectId(null);
      setSpawnOpen(false);
      syncSpawnProject(nextProjectId);
    } catch (spawnError) {
      showErrorToast(errorMessage(spawnError, "Failed to spawn Spur session"));
    } finally {
      spawningRef.current = false;
      setSpawning(false);
    }
  };

  const handleTakeBacklog = async (item: AvailableBacklogItem) => {
    const itemKey = `${item.projectId}:${item.backlogId}:${item.externalId}`;
    if (takingBacklogKey) return;
    setTakingBacklogKey(itemKey);
    try {
      const response = await fetch("/api/backlog/take", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: item.projectId,
          backlogId: item.backlogId,
          externalId: item.externalId,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      const result = (await response.json()) as TakeBacklogItemResponse;
      queryClient.setQueryData<SpurSessionsResponse>(sessionsQueryKey, (current) => {
        const currentSessions = (current?.sessions ?? []).filter(
          (existingSession) => existingSession.id !== result.session.id,
        );
        const currentBacklog = current?.backlog ?? [];
        return {
          ...(current ?? {}),
          sessions: [result.session, ...currentSessions],
          projects: current?.projects ?? [],
          backlog: currentBacklog.filter(
            (entry) =>
              !(
                entry.projectId === result.item.projectId &&
                entry.backlogId === result.item.backlogId &&
                entry.externalId === result.item.externalId
              ),
          ),
        };
      });
      await queryClient.invalidateQueries({ queryKey: sessionsQueryKey });
    } catch (takeError) {
      showErrorToast(errorMessage(takeError, "Failed to take backlog item"));
    } finally {
      setTakingBacklogKey(null);
    }
  };

  const openTerminal = (session: DashboardSession) => {
    syncTerminalFilter(session.id);
  };

  const openNewProjectModal = () => {
    setNewProjectDisplayName("");
    setNewProjectPrefix("");
    setNewProjectPath("");
    setNewProjectError(null);
    setNewProjectMissingPath(null);
    setNewProjectOpen(true);
  };

  const openEditProjectModal = (project: ProjectInfo) => {
    setEditingProject(project);
    setEditProjectDisplayName(project.name);
    setEditProjectPrefix(project.prefix);
    setEditProjectPath(project.path);
    setEditProjectError(null);
  };

  const closeEditProjectModal = () => {
    if (editProjectSubmitting || editProjectDeleting) return;
    setEditingProject(null);
    setEditProjectError(null);
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
      setNewProjectError(errorMessage(createError, "Failed to create Spur project"));
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

  const handleUpdateProject = async () => {
    if (!editingProject || editProjectSubmitting || editProjectDeleting) return;
    const displayName = editProjectDisplayName.trim();
    const prefix = editProjectPrefix.trim();
    const path = editProjectPath.trim();
    if (!displayName) {
      setEditProjectError("Display name is required");
      return;
    }
    if (!prefix) {
      setEditProjectError("Prefix is required");
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(prefix)) {
      setEditProjectError("Prefix must contain only letters, digits, underscores, or hyphens");
      return;
    }
    if (!path) {
      setEditProjectError("Path is required");
      return;
    }

    setEditProjectSubmitting(true);
    setEditProjectError(null);
    try {
      const body: UpdateProjectRequest = { displayName, prefix, path };
      const response = await fetch(`/api/projects/${encodeURIComponent(editingProject.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to update project (${response.status})`);
      }
      const updated = (await response.json()) as UpdateProjectResponse;
      queryClient.setQueryData<SpurSessionsResponse>(sessionsQueryKey, (current) => ({
        ...current,
        sessions: current?.sessions ?? [],
        projects: updated.projects,
      }));
      setEditingProject(null);
      setProjectActionError(null);
    } catch (updateError) {
      setEditProjectError(
        updateError instanceof Error ? updateError.message : "Failed to update Spur project",
      );
    } finally {
      setEditProjectSubmitting(false);
    }
  };

  const handleDeleteProject = async (project: ProjectInfo): Promise<boolean> => {
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to delete project (${response.status})`);
      }
      setProjectActionError(null);
      if (editingProject?.id === project.id) {
        setEditingProject(null);
      }
      await queryClient.invalidateQueries({ queryKey: sessionsQueryKey });
      return true;
    } catch (deleteError) {
      const message =
        deleteError instanceof Error ? deleteError.message : "Failed to delete Spur project";
      setProjectActionError(message);
      if (editingProject?.id === project.id) {
        setEditProjectError(message);
      }
      return false;
    }
  };

  const handleDeleteEditingProject = async () => {
    if (!editingProject || editProjectDeleting) return;
    setEditProjectDeleting(true);
    await handleDeleteProject(editingProject);
    setEditProjectDeleting(false);
  };

  const handleApplyTags = useCallback(
    async (sessionId: string, change: TagChange) => {
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/tags`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(change),
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? `Failed to update tags (${response.status})`);
        }
        await queryClient.invalidateQueries({ queryKey: sessionsQueryKey });
      } catch (tagError) {
        showErrorToast(errorMessage(tagError, "Failed to update tags"));
      }
    },
    [queryClient, sessionsQueryKey, showErrorToast],
  );

  const tagsContextValue = useMemo(
    () => ({ catalog: tagCatalog, applyTags: handleApplyTags }),
    [tagCatalog, handleApplyTags],
  );

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
    } catch (restoreError) {
      if (previousResponse) {
        queryClient.setQueryData<SpurSessionsResponse>(sessionsQueryKey, previousResponse);
      }
      showErrorToast(errorMessage(restoreError, "Failed to restore Spur session"));
      throw restoreError;
    } finally {
      await queryClient.invalidateQueries({ queryKey: sessionsQueryKey });
    }
  };

  const handleCompleteSession = async (session: DashboardSession, prAction?: OpenPrAction) => {
    const activeDeskSessions = sameDeskActiveSessions(allSessions, session);
    const activeSubagentCount = activeDeskSessions.filter(
      (candidate) => candidate.id !== session.id,
    ).length;
    if (!prAction && activeSubagentCount > 0 && typeof window !== "undefined") {
      const ok = window.confirm(
        `Complete this desk? ${activeSubagentCount} subagent${
          activeSubagentCount === 1 ? "" : "s"
        } on this checkout will be ended.`,
      );
      if (!ok) return;
    }
    const activeDeskIds = new Set(activeDeskSessions.map((candidate) => candidate.id));
    await queryClient.cancelQueries({ queryKey: sessionsQueryKey });
    const previousResponse = queryClient.getQueryData<SpurSessionsResponse>(sessionsQueryKey);

    queryClient.setQueryData<SpurSessionsResponse>(sessionsQueryKey, (current) => {
      if (!current) return current;
      return {
        ...current,
        sessions: current.sessions.map((currentSession) =>
          activeDeskIds.has(currentSession.id)
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
      const body = { scope: "desk", ...(prAction ? { prAction } : {}) };
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await readResponsePayload(response);
      if (!response.ok) {
        if (isOpenPrActionRequiredPayload(payload)) {
          if (previousResponse) {
            queryClient.setQueryData<SpurSessionsResponse>(sessionsQueryKey, previousResponse);
          }
          setOpenPrAction({ session, payload });
          return;
        }
        throw new Error(responseErrorMessage(payload, "Failed to complete Spur session"));
      }
      const completedIds = completedIdsFromResponse(payload);
      if (completedIds.length > 0) {
        const completedIdSet = new Set(completedIds);
        queryClient.setQueryData<SpurSessionsResponse>(sessionsQueryKey, (current) => {
          if (!current) return current;
          return {
            ...current,
            sessions: current.sessions.map((currentSession) =>
              completedIdSet.has(currentSession.id)
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
      }
    } catch (completeError) {
      if (previousResponse) {
        queryClient.setQueryData<SpurSessionsResponse>(sessionsQueryKey, previousResponse);
      }
      showErrorToast(errorMessage(completeError, "Failed to complete Spur session"));
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
    resetBabysitterState();
    setSpawnOpen(true);
  };

  const openShepherdSpawnModal = () => {
    setSpawnPinnedProjectId(SHEPHERD_PROJECT_ID);
    setSpawnProjectId(SHEPHERD_PROJECT_ID);
    setSpawnAgent("claude");
    setSpawnModel(null);
    setSpawnWorkspaceMode("default");
    setSpawnDefaultBranch("");
    setSpawnAttachments([]);
    resetBabysitterState();
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

  const addBabysitterFiles = useCallback((files: FileList | File[] | null) => {
    void fileAttachmentsFromFiles(files)
      .then((attachments) => {
        if (attachments.length === 0) return;
        setBabysitterAttachments((current) => [...current, ...attachments]);
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

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const input = searchInputRef.current;
      if (!input) return;
      const exactFindShortcut =
        event.key.toLowerCase() === "f" &&
        !event.altKey &&
        !event.shiftKey &&
        ((event.ctrlKey && !event.metaKey) || (event.metaKey && !event.ctrlKey));
      if (!exactFindShortcut || event.isComposing) return;
      if (spawnOpen || newProjectOpen || terminalSession || openPrAction) return;

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target !== input &&
        (target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          target.isContentEditable)
      ) {
        return;
      }

      event.preventDefault();
      input.focus();
      input.select();
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [newProjectOpen, openPrAction, spawnOpen, terminalSession]);

  return (
    <TagsContext.Provider value={tagsContextValue}>
      <main className="mx-auto max-w-[1500px] px-4 py-4 pb-8 sm:px-5 lg:px-6">
        <header className="mb-4 flex flex-wrap items-center gap-2 sm:gap-3">
          <ProjectMenu
            activeProjectName={activeProjectName}
            projects={filterProjectOptions}
            selectedProjectId={projectId}
            onSelectProject={syncProjectFilter}
            onNewProject={openNewProjectModal}
            onEdit={openEditProjectModal}
          />
          {stats.error > 0 ? (
            <StatItem
              icon={<IconAlert />}
              label="Errors"
              value={stats.error}
              color="var(--color-status-error)"
              active={activeStatFilter === "error"}
              onClick={() => toggleStatFilter("error")}
            />
          ) : null}
          {stats.rate_limited > 0 ? (
            <StatItem
              icon={<IconGauge />}
              label="Rate Limited"
              value={stats.rate_limited}
              color="var(--color-status-attention)"
              active={activeStatFilter === "rate_limited"}
              onClick={() => toggleStatFilter("rate_limited")}
            />
          ) : null}
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
          {filterTagCatalog.length > 0 ? (
            <span className="sm:ml-auto">
              <TagFilter
                catalog={filterTagCatalog}
                value={activeTagFilters}
                onChange={setActiveTagFilters}
              />
            </span>
          ) : null}
          <div
            className={`flex min-w-[12rem] flex-[999_1_16rem] flex-col gap-1 ${
              filterTagCatalog.length > 0 ? "" : "sm:ml-auto"
            }`}
          >
            <div className="flex items-stretch border border-[var(--color-border-default)] bg-[var(--color-bg-surface)]">
              <div className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5">
                <svg
                  className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-tertiary)]"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.35-4.35" />
                </svg>
                <input
                  aria-label="Filter sessions"
                  className="min-w-0 flex-1 border-none bg-transparent uppercase text-[var(--color-text-primary)] outline-none"
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (isVoiceToggleHotkey(event)) {
                      event.preventDefault();
                      searchVoice.toggleRecording();
                    }
                  }}
                  placeholder={voicePlaceholder("Filter sessions...", searchVoice)}
                  ref={searchInputRef}
                  value={searchQuery}
                />
              </div>
              <div className="flex shrink-0 items-stretch">
                {searchQuery.length > 0 ? (
                  <div className="flex items-center border-l border-[var(--color-border-default)] px-1">
                    <button
                      aria-label="Clear dashboard search"
                      className={DASHBOARD_SEARCH_TOOL_BUTTON_CLASS}
                      onClick={() => {
                        setSearchQuery("");
                        searchInputRef.current?.focus();
                      }}
                      type="button"
                    >
                      <CloseIcon />
                    </button>
                  </div>
                ) : null}
                {searchVoice.canUseVoice ? (
                  <div className="flex items-center border-l border-[var(--color-border-default)] px-1">
                    <VoiceControls
                      borderless
                      className={DASHBOARD_SEARCH_TOOL_BUTTON_CLASS}
                      groupClassName="flex items-center gap-1"
                      voice={searchVoice}
                    />
                  </div>
                ) : null}
              </div>
            </div>
            {searchVoice.voiceError ? (
              <div
                className="border border-[var(--color-chip-error-border)] bg-[var(--color-chip-error-bg)] px-2 py-1.5 text-[10px] text-[var(--color-chip-error-text)]"
                role="alert"
              >
                {searchVoice.voiceError}
              </div>
            ) : searchVoice.recording || searchVoice.voiceBusy ? (
              <div className="px-2 text-[10px] text-[var(--color-text-tertiary)]">
                <VoiceStatusHint voice={searchVoice} />
              </div>
            ) : null}
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

        {editingProject ? (
          <EditProjectModal
            project={editingProject}
            displayName={editProjectDisplayName}
            prefix={editProjectPrefix}
            path={editProjectPath}
            error={editProjectError}
            submitting={editProjectSubmitting}
            deleting={editProjectDeleting}
            onDisplayNameChange={setEditProjectDisplayName}
            onPrefixChange={setEditProjectPrefix}
            onPathChange={setEditProjectPath}
            onSubmit={() => {
              void handleUpdateProject();
            }}
            onDelete={() => {
              void handleDeleteEditingProject();
            }}
            onClose={closeEditProjectModal}
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
          <SpawnModal
            agent={spawnAgent}
            agentAriaLabel="Spawn agent"
            attachments={spawnAttachments}
            canClose
            clearLabel="Clear spawn prompt"
            history={{ entries: spawnHistory.entries, onSelect: setSpawnPrompt }}
            mode={{
              kind: "spawn",
              project: {
                value: spawnProjectId,
                onChange: syncSpawnProject,
                options: configuredProjectOptions.map((project) => ({
                  id: project.id,
                  label: projectOptionLabel(project),
                })),
              },
              model: { value: spawnModel, onChange: setSpawnModel },
              branch: {
                value: spawnBranch,
                onChange: setSpawnBranch,
                onBlur: () => setSpawnBranch(normalizeBranchName(spawnBranch)),
              },
              workspaceMode: { value: spawnWorkspaceMode, onChange: setSpawnWorkspaceMode },
              planMode: { value: spawnPlanMode, onChange: setSpawnPlanMode },
              selfDestruct: { value: spawnSelfDestruct, onChange: setSpawnSelfDestruct },
              steps: {
                items: spawnSteps,
                onUpdate: updateStep,
                onAdd: addStep,
                onRemove: removeStep,
              },
              branchNotesSlot: (
                <>
                  {normalizedBranchPreview && normalizedBranchPreview !== spawnBranch ? (
                    <p className="text-xs text-[var(--color-text-tertiary)]">
                      will create {normalizedBranchPreview}
                    </p>
                  ) : null}
                  {branchExists && branchExists.exists && !branchExists.checkedOutAt ? (
                    <p className="text-xs text-[var(--color-text-tertiary)]">
                      branch already exists — will attach instead of creating new
                    </p>
                  ) : null}
                  {branchExists && branchExists.exists && branchExists.checkedOutAt ? (
                    <div className="border border-[var(--color-chip-error-border)] bg-[var(--color-chip-error-bg)] px-2.5 py-1.5 text-xs text-[var(--color-chip-error-text)]">
                      already checked out in another worktree — spawn will fail; pick a different
                      name
                    </div>
                  ) : null}
                  {branchExists && !branchExists.exists && branchExists.remote ? (
                    <p className="text-xs text-[var(--color-text-tertiary)]">
                      exists on origin — will track it
                    </p>
                  ) : null}
                </>
              ),
              selfDestructSlot: spawnSelfDestruct ? (
                <textarea
                  aria-label="Self-destruct conditions"
                  className={`min-h-20 w-full resize-y ${INPUT_CLASS}`}
                  onChange={(event) => setSpawnSelfDestructConditions(event.target.value)}
                  placeholder="Self-destruct conditions"
                  value={spawnSelfDestructConditions}
                />
              ) : null,
              baseBranchSlot:
                spawnWorkspaceMode === "worktree" ? (
                  <input
                    className={`w-full ${INPUT_CLASS}`}
                    onChange={(event) => setSpawnDefaultBranch(event.target.value)}
                    placeholder="Base branch"
                    value={spawnDefaultBranch}
                  />
                ) : null,
              babysitter: {
                enabled: spawnBabysitterEnabled,
                onToggle: (next) => {
                  setSpawnBabysitterEnabled(next);
                  if (!next) setBabysitterPromptTouched(false);
                },
                inputSlot: spawnBabysitterEnabled ? (
                  <div className="flex flex-col gap-2 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                        Babysitter prompt
                      </span>
                      <span className="text-[10px] text-[var(--color-text-tertiary)]">
                        <VoiceStatusHint voice={babysitterVoice} />
                      </span>
                    </div>
                    <FileAttachmentTextarea
                      ariaLabel="Babysitter prompt"
                      attachments={babysitterAttachments}
                      clearLabel="Clear babysitter prompt"
                      minHeightClass="min-h-32"
                      onAddFiles={addBabysitterFiles}
                      onBlur={() => setBabysitterPromptTouched(true)}
                      onChange={setBabysitterPrompt}
                      onRemoveAttachment={(index) =>
                        setBabysitterAttachments((current) =>
                          current.filter((_, currentIndex) => currentIndex !== index),
                        )
                      }
                      placeholder={voicePlaceholder(
                        "Prompt for the babysitter session...",
                        babysitterVoice,
                      )}
                      textareaRef={babysitterPromptRef}
                      value={babysitterPrompt}
                      voice={babysitterVoice}
                    />
                    {babysitterVoice.voiceError ? (
                      <div className="border border-[var(--color-chip-error-border)] bg-[var(--color-chip-error-bg)] px-2.5 py-1.5 text-xs text-[var(--color-chip-error-text)]">
                        {babysitterVoice.voiceError}
                      </div>
                    ) : null}
                    {babysitterPromptTouched && babysitterPromptMissing ? (
                      <div
                        className="border border-[var(--color-chip-error-border)] bg-[var(--color-chip-error-bg)] px-2.5 py-1.5 text-xs text-[var(--color-chip-error-text)]"
                        role="alert"
                      >
                        Babysitter prompt is required when Add babysitter is enabled
                      </div>
                    ) : null}
                    <div className="flex items-center justify-end gap-2">
                      <SlashSuggestions
                        endpoint={
                          spawnProjectId.trim()
                            ? `/api/projects/${encodeURIComponent(spawnProjectId.trim())}/slash-commands?agent=${encodeURIComponent(spawnAgent)}`
                            : null
                        }
                        onSelect={(entry) =>
                          insertTextAtCursor(
                            babysitterPromptRef.current,
                            entry.insertText,
                            setBabysitterPrompt,
                          )
                        }
                      />
                      <InputHistoryButton
                        entries={babysitterHistory.entries}
                        onSelect={setBabysitterPrompt}
                      />
                    </div>
                  </div>
                ) : null,
              },
            }}
            onAddFiles={addSpawnFiles}
            onAgentChange={(next) => {
              setSpawnAgent(next);
              setSpawnModel(null);
            }}
            onClose={() => setSpawnOpen(false)}
            onPromptChange={setSpawnPrompt}
            onRemoveAttachment={(index) =>
              setSpawnAttachments((current) =>
                current.filter((_, currentIndex) => currentIndex !== index),
              )
            }
            onSubmit={() => void handleSpawn()}
            prompt={spawnPrompt}
            promptAriaLabel="Prompt for the new session..."
            promptMinHeightClass="min-h-[24rem] sm:min-h-[28rem]"
            promptPlaceholder="Prompt for the new session..."
            promptRef={spawnPromptRef}
            showCancel={false}
            slashEndpoint={
              spawnProjectId.trim()
                ? `/api/projects/${encodeURIComponent(spawnProjectId.trim())}/slash-commands?agent=${encodeURIComponent(spawnAgent)}`
                : null
            }
            submitBusyLabel="Spawning..."
            submitDisabled={spawning || !spawnProjectId.trim() || babysitterPromptMissing}
            submitLabel="Spawn"
            submitting={spawning}
            title="Spawn Session"
            voice={voice}
          />
        ) : null}

        {loading ? (
          <p className="mt-4 text-sm text-[var(--color-text-secondary)]">Loading sessions...</p>
        ) : null}

        {!loading && !hasVisibleSessions && !hasVisibleBacklog ? (
          <section className="mt-5">
            <EmptyState message={emptyStateMessage} />
            {hasActiveFilters ? (
              <div className="mt-3 flex justify-center">
                <button
                  className="border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                  onClick={() => {
                    setSearchQuery("");
                    setActiveStatFilter(null);
                    setActiveTagFilters([]);
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

        {!loading && (hasVisibleBacklog || hasVisibleSessions) ? (
          <section className="mt-5 space-y-4">
            {hasVisibleBacklog ? (
              <BacklogZone
                items={visibleBacklog}
                projectNameMap={projectNameMap}
                takingKey={takingBacklogKey}
                onTake={handleTakeBacklog}
              />
            ) : null}
            {visibleLevels.map((level) => (
              <AttentionZone
                key={level}
                collapsed={isMobile ? collapsedLevels.has(level) : undefined}
                level={level}
                onCompleteSession={handleCompleteSession}
                onOpenTerminal={openTerminal}
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
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
      <StatusBar />
    </TagsContext.Provider>
  );
}
