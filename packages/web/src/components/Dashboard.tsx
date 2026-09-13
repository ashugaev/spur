"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AttentionZone } from "@/components/AttentionZone";
import { BusyContent } from "@/components/BusyContent";
import { CenteredLoader } from "@/components/CenteredLoader";
import { BrandGlyph } from "@/components/BrandGlyph";
import { DataRow, RowIconButton } from "@/components/DataRow";
import { Zone } from "@/components/Zone";
import { StatusBar } from "@/components/StatusBar";
import { EmptyState } from "@/components/EmptyState";
import { CloseIcon } from "@/components/icons/CloseIcon";
import { FiltersModal } from "@/components/FiltersModal";
import { GithubRateLimitDialog } from "@/components/GithubRateLimitDialog";
import { OpenPrActionDialog } from "@/components/OpenPrActionDialog";
import { SpawnModal } from "@/components/SpawnModal";
import { TerminalModal } from "@/components/TerminalModal";
import { ToastViewport } from "@/components/Toast";
import { VoiceControls, VoiceStatusHint, voicePlaceholder } from "@/components/VoiceInput";
import { INPUT_CLASS } from "@/design/classes";
import { useFooterPopover } from "@/lib/footer-popover";
import { useInputHistory } from "@/hooks/useInputHistory";
import { MOBILE_BREAKPOINT, useMediaQuery } from "@/hooks/useMediaQuery";
import { buildSpawnOverrides, buildSpawnSessionPayload } from "@/lib/spawn-payload";
import { useToasts } from "@/hooks/useToasts";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import {
  errorMessage,
  readApiErrorMessage,
  readResponsePayload,
  responseErrorMessage,
} from "@/lib/json-payload";
import {
  fileAttachmentsFromFiles,
  mergeAttachmentsWithinLimit,
  type FileAttachment,
} from "@/lib/file-attachments";
import { JiraIcon, isReviewLinkLabel, usePrReadyUrls } from "@/lib/link-icons";
import { matchesSessionSearch } from "@/lib/session-search";
import { getTerminalQuerySessionId, withTerminalQuery } from "@/lib/project-routes";
import { normalizeBranchName } from "@/lib/branch-name";
import { DEFAULT_SELF_DESTRUCT_CONDITION } from "@/lib/self-destruct";
import {
  clearSpawnDraft,
  readSpawnDraft,
  writeSpawnDraft,
  type SpawnDraft,
} from "@/lib/spawn-draft";
import { useResolvedSpawnDefaults } from "@/lib/spawn-defaults";
import { isBacklogItemActivelyWorked } from "@/lib/backlog-match";
import { reconcileSessionMode, sessionModeOptions } from "@/lib/session-modes";
import { AGENT_OPTIONS, type AgentName } from "@/lib/agents";
import { isVoiceToggleHotkey } from "@/lib/submit-hotkeys";
import {
  ATTENTION_LANE_META,
  ATTENTION_ZONE_ORDER,
  collapseDeskRows,
  isGithubPrCheckUnavailablePayload,
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
  type GithubPrCheckUnavailablePayload,
  type OpenPrAction,
  type OpenPrActionRequiredPayload,
  type ProjectInfo,
  type SpurSessionView,
  type SpurSessionsResponse,
  type UpdateProjectRequest,
  type UpdateProjectResponse,
  type WorkspaceMode,
} from "@/lib/types";
import { TagsContext, type TagChange } from "@/components/TagsContext";
import { useBackendConnection } from "@/lib/backend-connection-context";
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
const SPAWN_DRAFT_SAVE_DELAY_MS = 500;
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

function sessionReviewUrl(session: DashboardSession): string | undefined {
  return session.links.find((link) => isReviewLinkLabel(link.label))?.url;
}

interface FacetFilterState {
  projectId: string;
  tagFilters: readonly string[];
  agentFilter: readonly AgentName[];
  searchQuery: string;
  prReadyOnly: boolean;
  prReady: { readonly ready: ReadonlySet<string>; readonly loaded: boolean };
}

type FacetDimension = "project" | "tag" | "agent" | "prReady";

// Whether `session` passes every facet filter dimension EXCEPT `exclude` —
// the shared predicate behind every Filters modal chip count, so a chip
// never counts against its own selection.
function sessionMatchesFacetFilters(
  session: DashboardSession,
  exclude: FacetDimension,
  filters: FacetFilterState,
): boolean {
  if (exclude !== "project" && filters.projectId && session.projectId !== filters.projectId) {
    return false;
  }
  if (
    exclude !== "tag" &&
    filters.tagFilters.length > 0 &&
    !filters.tagFilters.some((tag) => session.tags.includes(tag))
  ) {
    return false;
  }
  if (
    exclude !== "agent" &&
    filters.agentFilter.length > 0 &&
    !filters.agentFilter.includes(session.agent)
  ) {
    return false;
  }
  if (filters.searchQuery && !matchesSessionSearch(session, filters.searchQuery)) {
    return false;
  }
  if (exclude !== "prReady" && filters.prReadyOnly && filters.prReady.loaded) {
    const url = sessionReviewUrl(session);
    if (!url || !filters.prReady.ready.has(url)) return false;
  }
  return true;
}

// Tallies desks (not sessions) per facet key: a desk counts once for a key
// as soon as ANY member session carries it — the same "any member of the
// desk" rule `tagFilteredSessions` / `agentFilteredSessions` /
// `prReadyFilteredSessions` use to actually narrow the list, so a desk whose
// matching session (e.g. a ready PR link) lives on a subagent rather than
// the anchor still counts here. Drives every Filters modal chip count
// (project, agent, tag, PR-ready) through one path instead of four
// hand-rolled copies, each of which must independently remember to skip
// only its own dimension.
function buildFacetCounts<T extends string>(
  sessions: readonly DashboardSession[],
  exclude: FacetDimension,
  filters: FacetFilterState,
  keyFn: (session: DashboardSession) => readonly T[],
): Map<T, number> {
  const deskKeysByValue = new Map<T, Set<string>>();
  for (const session of sessions) {
    if (!sessionMatchesFacetFilters(session, exclude, filters)) continue;
    for (const key of keyFn(session)) {
      let deskKeys = deskKeysByValue.get(key);
      if (!deskKeys) {
        deskKeys = new Set();
        deskKeysByValue.set(key, deskKeys);
      }
      deskKeys.add(session.deskKey);
    }
  }
  const counts = new Map<T, number>();
  for (const [key, deskKeys] of deskKeysByValue) counts.set(key, deskKeys.size);
  return counts;
}

// Desks matching every active filter except `exclude` — the "All" chip count
// for that dimension. Not the sum of that section's per-option counts: a desk
// carrying two tags counts once here but once per tag in `buildFacetCounts`,
// and untagged desks count here but appear in no per-tag bucket.
function countFacetDesks(
  sessions: readonly DashboardSession[],
  exclude: FacetDimension,
  filters: FacetFilterState,
): number {
  const deskKeys = new Set<string>();
  for (const session of sessions) {
    if (sessionMatchesFacetFilters(session, exclude, filters)) deskKeys.add(session.deskKey);
  }
  return deskKeys.size;
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

function BacklogZone({
  items,
  projectNameMap,
  onTake,
}: {
  items: readonly AvailableBacklogItem[];
  projectNameMap: Map<string, string>;
  onTake: (item: AvailableBacklogItem) => void;
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
              disabled={false}
              label="Take task"
              onClick={() => onTake(item)}
            >
              <IconTake />
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

function IconSliders() {
  return (
    <svg
      aria-hidden="true"
      className="h-[13px] w-[13px] opacity-75"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
    >
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="9" cy="6" r="2" fill="var(--color-bg-base)" />
      <circle cx="16" cy="12" r="2" fill="var(--color-bg-base)" />
      <circle cx="11" cy="18" r="2" fill="var(--color-bg-base)" />
    </svg>
  );
}

function IconPlus({ className }: { className: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

// Icon per lane for the Filters modal Status section. Label/color live in
// the single shared `ATTENTION_LANE_META` (also used by AttentionZone), so
// only the icon assignment — which AttentionZone doesn't render — stays here.
const STATUS_LANE_ICONS: Record<AttentionLevel, ReactNode> = {
  error: <IconAlert />,
  rate_limited: <IconGauge />,
  respond: <IconChat />,
  working: <IconBolt />,
  pending: <IconClock />,
  stopped: <IconStop />,
  done: <IconCheck />,
};

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
        className="inline-flex min-w-0 max-w-full items-center text-[var(--color-text-primary)] transition hover:text-[var(--color-accent)]"
        type="button"
        onClick={popover.toggle}
      >
        <span className="inline-flex min-w-0 max-w-[230px] items-center gap-1 text-base font-bold uppercase tracking-[-0.02em]">
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
          className="absolute left-0 top-full z-50 mt-1 flex max-h-[calc(100dvh-4rem)] min-w-[260px] max-w-[calc(100vw-1rem)] flex-col border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-2 shadow-[0_4px_12px_var(--color-shadow-modal-sm)]"
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
            <ul className="flex min-h-0 flex-col overflow-y-auto" role="group">
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
          <span className="text-[var(--color-text-secondary)]">Project path (optional)</span>
          <input
            aria-label="Project path"
            className={INPUT_CLASS}
            onChange={(event) => onPathChange(event.target.value)}
            placeholder="/absolute/path/to/repo (optional)"
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
            aria-busy={submitting || undefined}
            aria-label={submitting ? "Creating project" : undefined}
            className="bg-[var(--color-accent)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            disabled={submitting}
            onClick={onSubmit}
            type="button"
          >
            <BusyContent busy={submitting}>Create</BusyContent>
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
              {project.configured ? `Disconnect ${project.name}?` : `Delete ${project.name}?`}
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
                aria-busy={deleting || undefined}
                aria-label={deleting ? `${deleteLabel} in progress` : undefined}
                className="inline-flex items-center gap-1.5 border border-[var(--color-status-error)] px-3 py-1.5 font-bold uppercase text-[var(--color-status-error)] transition hover:bg-[var(--color-bg-surface)] disabled:cursor-not-allowed disabled:opacity-60"
                disabled={deleting}
                onClick={onDelete}
                type="button"
              >
                <BusyContent busy={deleting}>
                  <IconTrash />
                  {`Confirm ${deleteLabel}`}
                </BusyContent>
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
                aria-busy={submitting || undefined}
                aria-label={submitting ? "Saving project" : undefined}
                className="bg-[var(--color-accent)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                disabled={submitting}
                onClick={onSubmit}
                type="button"
              >
                <BusyContent busy={submitting}>Save</BusyContent>
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export function Dashboard() {
  // Initialized empty rather than read from `window.location.search` at render
  // time: the server always renders "", so a non-empty client-side first
  // render would be a hydration text mismatch. The layout effect below is the
  // only path that populates these, restoring both together pre-paint. This
  // removes the mismatch these two states used to contribute — it is not a
  // whole-component guarantee: `readCollapsedCategories` and the
  // `activeTagFilters` initializer further below still read localStorage
  // during render. Both are unreachable pre-paint today only because they're
  // gated behind fetched-session state, not because render-time storage reads
  // are safe in general.
  const [locationSearch, setLocationSearch] = useState("");
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const [projectId, setProjectId] = useState("");
  const { toasts, showErrorToast, dismissToast } = useToasts();
  const [openPrAction, setOpenPrAction] = useState<{
    session: DashboardSession;
    payload: OpenPrActionRequiredPayload;
  } | null>(null);
  const [openPrActionBusy, setOpenPrActionBusy] = useState(false);
  const [prCheckUnavailable, setPrCheckUnavailable] = useState<{
    session: DashboardSession;
    payload: GithubPrCheckUnavailablePayload;
  } | null>(null);
  const [prCheckUnavailableBusy, setPrCheckUnavailableBusy] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [spawnProjectId, setSpawnProjectId] = useState("");
  const [spawnPinnedProjectId, setSpawnPinnedProjectId] = useState<string | null>(null);
  const [spawnPrompt, setSpawnPrompt] = useState("");
  const [spawnAgent, setSpawnAgent] = useState<AgentName>("claude");
  const [spawnModel, setSpawnModel] = useState<string | null>(null);
  // Settled/unsettled model resolution, reported by ModelSelect itself. Submit
  // gates on this, not on `spawnModel === null` — a settled-empty catalog
  // also has a null model but is a valid, submittable state.
  const [spawnModelResolved, setSpawnModelResolved] = useState(false);
  // The model catalog's own fetch error (distinct from spawnDefaults.error
  // below); ModelSelect keeps `resolved` false while this is set, same as an
  // unresolved workspace-mode default, and this surfaces in the same banner.
  const [spawnModelError, setSpawnModelError] = useState<string | null>(null);
  const [spawnSessionMode, setSpawnSessionMode] = useState<string | null>(null);
  const [spawnBranch, setSpawnBranch] = useState("");
  const spawnBranchExplicitRef = useRef(false);
  const [branchExists, setBranchExists] = useState<BranchExistsResponse | null>(null);
  const [spawnPlanMode, setSpawnPlanMode] = useState(false);
  const [spawnSelfDestruct, setSpawnSelfDestruct] = useState(false);
  const [spawnSelfDestructConditions, setSpawnSelfDestructConditions] = useState("");
  const [spawnSteps, setSpawnSteps] = useState<{ id: number; value: string }[]>([]);
  const [spawnWorkspaceMode, setSpawnWorkspaceMode] = useState<WorkspaceMode>("worktree");
  // The project id spawnWorkspaceMode was last explicitly confirmed for (a
  // manual select pick or an error-banner "Use worktree/shared" click), or
  // null if it has never been explicitly confirmed. A confirmation belongs
  // to exactly one project; it never carries over to a different one, so
  // "auto" below is derived by comparing against the CURRENT project rather
  // than stored as its own flag — a project switch re-derives it for free,
  // with nothing to keep in sync by hand.
  const [spawnWorkspaceModeConfirmedFor, setSpawnWorkspaceModeConfirmedFor] = useState<
    string | null
  >(null);
  const spawnWorkspaceModeAuto = spawnWorkspaceModeConfirmedFor !== spawnProjectId;
  const [spawnDefaultBranch, setSpawnDefaultBranch] = useState("");
  const [spawnAttachments, setSpawnAttachments] = useState<FileAttachment[]>([]);
  const [spawning, setSpawning] = useState(false);
  const spawningRef = useRef(false);
  const [spawnTrackerUrl, setSpawnTrackerUrl] = useState<string | null>(null);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const spawnPromptRef = useRef<HTMLTextAreaElement>(null);
  const spawnHistory = useInputHistory(SPAWN_PROMPT_HISTORY_STORAGE_KEY);
  const voice = useVoiceInput({
    contextKey: "spawn",
    onTranscribed: (text) => {
      setSpawnPrompt((current) => (current.trim() ? `${current}\n${text}` : text));
    },
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
  const [agentFilter, setAgentFilter] = useState<AgentName[]>([]);
  // Not persisted: PR readiness is remote state that flips without user
  // action, so a persisted "empty dashboard" on next load would have no
  // user-visible cause — unlike user-authored tags. Matches the
  // un-persisted `activeStatFilter` above.
  const [prReadyOnly, setPrReadyOnly] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
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
  const selectStatFilter = (level: AttentionLevel | null) =>
    setActiveStatFilter((current) => (current === level ? null : level));
  const toggleAgentFilter = (agent: AgentName) =>
    setAgentFilter((current) =>
      current.includes(agent) ? current.filter((name) => name !== agent) : [...current, agent],
    );
  const clearTagFilters = () => setActiveTagFilters([]);
  const clearAgentFilters = () => setAgentFilter([]);
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

  // Restore locationSearch + projectId from the URL in a layout effect, not a
  // passive effect: layout effects flush before the browser paints, so the
  // project name is correct on the first paint AFTER hydration, instead of
  // one extra frame of "All Projects" while a passive effect chain catches
  // up. (The very first frame — the raw SSR HTML before hydration runs — is
  // always "All Projects" regardless; that's an accepted, out-of-scope SSR
  // characteristic, not something this effect can change.) The render-time
  // initial state stays "" (above) so the server's first render and the
  // client's first render still agree — no hydration mismatch — and this
  // effect only runs after that hydration has already committed
  // successfully.
  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    const syncFromLocation = () => {
      const search = readLocationSearch();
      setLocationSearch(search);
      setProjectId(new URLSearchParams(search).get("project")?.trim() ?? "");
    };
    syncFromLocation();
    window.addEventListener("popstate", syncFromLocation);
    return () => {
      window.removeEventListener("popstate", syncFromLocation);
    };
  }, []);

  const requestedTerminalSessionId = useMemo(
    () => getTerminalQuerySessionId(new URLSearchParams(locationSearch)),
    [locationSearch],
  );

  const queryClient = useQueryClient();
  const sessionsQueryKey = useMemo(() => ["sessions"] as const, []);
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
  const { phase: backendPhase } = useBackendConnection();

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
    // flight, or while the backend-connection gate is showing its own
    // blocking overlay — don't surface that as a new session-load error
    // toast, and clear any pre-existing one so it doesn't linger behind the
    // overlay.
    if (
      versionSwitchPhase === "switching" ||
      versionSwitchPhase === "done" ||
      backendPhase === "disconnected"
    ) {
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
  }, [backendPhase, dismissToast, sessionsError, showErrorToast, versionSwitchPhase]);

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

  const agentFilteredSessions = useMemo(() => {
    if (agentFilter.length === 0) return tagFilteredSessions;
    const keys = new Set(
      tagFilteredSessions.filter((s) => agentFilter.includes(s.agent)).map((s) => s.deskKey),
    );
    return tagFilteredSessions.filter((s) => keys.has(s.deskKey));
  }, [tagFilteredSessions, agentFilter]);

  // One review-link URL per session (undefined when a session has no GitHub
  // or GitLab review link). usePrReadyUrls filters to GitHub-only itself and
  // only fetches while prReadyOnly is true.
  const reviewUrls = useMemo(
    () =>
      agentFilteredSessions
        .map((session) => sessionReviewUrl(session))
        .filter((url): url is string => Boolean(url)),
    [agentFilteredSessions],
  );
  const prReady = usePrReadyUrls(reviewUrls, prReadyOnly);

  const prReadyFilteredSessions = useMemo(() => {
    if (!prReadyOnly || !prReady.loaded) return agentFilteredSessions;
    const keys = new Set(
      agentFilteredSessions
        .filter((s) => {
          const url = sessionReviewUrl(s);
          return url ? prReady.ready.has(url) : false;
        })
        .map((s) => s.deskKey),
    );
    return agentFilteredSessions.filter((s) => keys.has(s.deskKey));
  }, [agentFilteredSessions, prReadyOnly, prReady]);

  const sessions = useMemo(() => {
    if (!searchQuery.trim()) return prReadyFilteredSessions;
    const narrowed = prReadyFilteredSessions.filter((session) =>
      matchesSessionSearch(session, searchQuery),
    );
    const keys = new Set(narrowed.map((s) => s.deskKey));
    return prReadyFilteredSessions.filter((s) => keys.has(s.deskKey));
  }, [prReadyFilteredSessions, searchQuery]);

  const visibleBacklog = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return availableBacklog.filter((item) => {
      if (isBacklogItemActivelyWorked(item, allSessions)) return false;
      if (projectId && item.projectId !== projectId) return false;
      if (!q) return true;
      return (
        item.key.toLowerCase().includes(q) ||
        item.title.toLowerCase().includes(q) ||
        item.projectId.toLowerCase().includes(q)
      );
    });
  }, [availableBacklog, allSessions, projectId, searchQuery]);

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

  const allStatusesCount = deskCollapsedRows.length;

  // Faceted counts for the Filters modal chips, all driven through
  // `buildFacetCounts` off the full, unfiltered `allSessions`: each
  // dimension excludes only itself and applies every other active filter —
  // including `prReadyOnly` — so toggling one option never zeroes out, nor
  // silently under-counts, the rest of that same section.
  const facetFilters: FacetFilterState = useMemo(
    () => ({
      projectId,
      tagFilters: activeTagFilters,
      agentFilter,
      searchQuery: searchQuery.trim(),
      prReadyOnly,
      prReady,
    }),
    [projectId, activeTagFilters, agentFilter, searchQuery, prReadyOnly, prReady],
  );

  const projectCounts = useMemo(
    () => buildFacetCounts(allSessions, "project", facetFilters, (s) => [s.projectId]),
    [allSessions, facetFilters],
  );

  const allProjectsCount = useMemo(
    () => [...projectCounts.values()].reduce((total, count) => total + count, 0),
    [projectCounts],
  );

  const agentCounts = useMemo(
    () => buildFacetCounts(allSessions, "agent", facetFilters, (s) => [s.agent]),
    [allSessions, facetFilters],
  );

  const allAgentsCount = useMemo(
    () => countFacetDesks(allSessions, "agent", facetFilters),
    [allSessions, facetFilters],
  );

  const tagCounts = useMemo(
    () => buildFacetCounts(allSessions, "tag", facetFilters, (s) => s.tags),
    [allSessions, facetFilters],
  );

  const allTagsCount = useMemo(
    () => countFacetDesks(allSessions, "tag", facetFilters),
    [allSessions, facetFilters],
  );

  // Bounded by prReady.loaded (itself bounded by prReadyOnly) rather than
  // its own facet query: computing this independently of the toggle would
  // require fetching PR readiness for every session at all times, which
  // violates "no /api/pr-status/batch request while prReadyOnly is false".
  const prReadyCount = useMemo(() => {
    if (!prReady.loaded) return 0;
    const counts = buildFacetCounts(allSessions, "prReady", facetFilters, (s) => {
      const url = sessionReviewUrl(s);
      return url && prReady.ready.has(url) ? (["ready"] as const) : [];
    });
    return counts.get("ready") ?? 0;
  }, [allSessions, facetFilters, prReady]);

  const activeFilterCount =
    (projectId ? 1 : 0) +
    (activeStatFilter !== null ? 1 : 0) +
    activeTagFilters.length +
    agentFilter.length +
    (prReadyOnly ? 1 : 0);

  const hasActiveFilters = activeFilterCount > 0 || searchQuery.trim().length > 0;

  const resetAllFilters = () => {
    setSearchQuery("");
    setActiveStatFilter(null);
    setActiveTagFilters([]);
    setAgentFilter([]);
    setPrReadyOnly(false);
    syncProjectFilter("");
  };
  const hasVisibleSessions = visibleLevels.length > 0;
  const hasVisibleBacklog = activeStatFilter === null && visibleBacklog.length > 0;
  const activeProjectName = projectId
    ? (filterProjectOptions.find((project) => project.id === projectId)?.name ?? projectId)
    : "All Projects";
  const emptyStateMessage = hasActiveFilters
    ? `No sessions match this filter${projectId ? ` in ${activeProjectName}` : ""}. Reset the filters, or spawn a new session.`
    : grouped.done.length > 0
      ? "No active sessions."
      : undefined;

  const configuredProjectOptions = useMemo(
    () => filterProjectOptions.filter((project) => project.configured),
    [filterProjectOptions],
  );

  const selectedSpawnProjectModes = filterProjectOptions.find(
    (project) => project.id === spawnProjectId,
  )?.modes;
  const effectiveSessionMode = reconcileSessionMode(selectedSpawnProjectModes, spawnSessionMode);
  const spawnModeOptions = sessionModeOptions(selectedSpawnProjectModes);

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

  const applySpawnDraft = (nextProjectId: string, draft: SpawnDraft | null) => {
    setSpawnProjectId(nextProjectId);
    setSpawnPrompt(draft?.prompt ?? "");
    setSpawnAgent(draft?.agent ?? "claude");
    setSpawnModel(draft?.model ?? null);
    setSpawnSessionMode(draft?.sessionMode ?? null);
    setSpawnBranch(draft?.branch ?? "");
    spawnBranchExplicitRef.current = draft?.branchIsExplicit ?? false;
    setSpawnPlanMode(draft?.planMode ?? false);
    setSpawnSelfDestruct(draft?.selfDestruct ?? false);
    setSpawnSelfDestructConditions(draft?.selfDestructConditions ?? "");
    setSpawnSteps(draft?.steps.map((value, index) => ({ id: -(index + 1), value })) ?? []);
    // A draft is a single storage key shared by every project, so a stored
    // workspaceMode is usually the auto-derived default for whatever
    // project it was last saved against, not a confirmation for
    // nextProjectId. Restoring the project the confirmation actually
    // belongs to (rather than a bare yes/no flag) means the "auto" derived
    // above naturally comes out false only when nextProjectId matches it.
    setSpawnWorkspaceModeConfirmedFor(draft?.workspaceModeConfirmedFor ?? null);
    setSpawnWorkspaceMode(draft?.workspaceMode ?? "worktree");
    setSpawnDefaultBranch(draft?.defaultBranch ?? "");
    setSpawnTrackerUrl(draft?.trackerUrl ?? null);
    setSpawnAttachments([]);
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
    // No explicit reset needed here: spawnWorkspaceModeAuto is derived from
    // spawnWorkspaceModeConfirmedFor !== spawnProjectId, so switching the
    // project alone re-derives it — a confirmation made for the previous
    // project stops applying the instant the project changes, and one made
    // for THIS project (from before an earlier switch away) re-applies for
    // free once the project matches again.
    if (typeof window === "undefined") return;
    if (normalizedProjectId) {
      window.localStorage.setItem(LAST_SPAWN_PROJECT_STORAGE_KEY, normalizedProjectId);
      return;
    }
    window.localStorage.removeItem(LAST_SPAWN_PROJECT_STORAGE_KEY);
  };

  // Fetched once here and passed down into ModelSelect (mode.model.spawnDefaults)
  // instead of letting it fetch its own copy — one request per project+agent,
  // and the workspace-mode default below and the model rung 3 default both
  // read the same settle. projectId is empty while the owning modal is
  // closed, so no request fires until it is actually open.
  const spawnDefaults = useResolvedSpawnDefaults(spawnOpen ? spawnProjectId : "", spawnAgent);
  useEffect(() => {
    if (!spawnWorkspaceModeAuto || spawnDefaults.worktree === null) return;
    setSpawnWorkspaceMode(spawnDefaults.worktree ? "worktree" : "shared");
  }, [spawnWorkspaceModeAuto, spawnDefaults.worktree]);
  // While still on the auto-derived workspace mode, an in-flight or failed
  // spawn-defaults request means the true project default is unknown; block
  // submit rather than silently spawning against the "worktree" fallback
  // state. A manual pick (auto false) always overrides this.
  const spawnWorkspaceModeUnresolved =
    spawnWorkspaceModeAuto && (spawnDefaults.loading || spawnDefaults.error !== null);

  const spawnDraft = useMemo<SpawnDraft>(() => {
    return {
      prompt: spawnPrompt,
      agent: spawnAgent,
      model: spawnModel,
      branch: spawnBranch,
      branchIsExplicit: spawnBranchExplicitRef.current,
      workspaceMode: spawnWorkspaceMode,
      workspaceModeConfirmedFor: spawnWorkspaceModeConfirmedFor,
      defaultBranch: spawnDefaultBranch,
      planMode: spawnPlanMode,
      selfDestruct: spawnSelfDestruct,
      selfDestructConditions: spawnSelfDestructConditions,
      steps: spawnSteps.map((step) => step.value),
      trackerUrl: spawnTrackerUrl,
      sessionMode: spawnSessionMode,
    };
  }, [
    spawnAgent,
    spawnBranch,
    spawnDefaultBranch,
    spawnModel,
    spawnPlanMode,
    spawnPrompt,
    spawnSelfDestruct,
    spawnSelfDestructConditions,
    spawnSessionMode,
    spawnSteps,
    spawnTrackerUrl,
    spawnWorkspaceMode,
    spawnWorkspaceModeConfirmedFor,
  ]);
  const spawnDraftRef = useRef(spawnDraft);
  spawnDraftRef.current = spawnDraft;

  useEffect(() => {
    if (!spawnOpen) return;
    const timer = setTimeout(() => writeSpawnDraft(spawnDraft), SPAWN_DRAFT_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [spawnDraft, spawnOpen]);

  const closeSpawnModal = useCallback(() => {
    writeSpawnDraft(spawnDraftRef.current);
    setSpawnOpen(false);
  }, []);

  useEffect(() => {
    if (!spawnOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSpawnModal();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [closeSpawnModal, spawnOpen]);

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

  const markSessionOpened = useCallback(
    async (sessionId: string) => {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/opened`, {
        method: "POST",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`opened ${response.status}`);
      const openedSession = (await response.json()) as SpurSessionView;
      queryClient.setQueryData<SpurSessionsResponse>(sessionsQueryKey, (current) => {
        if (!current) return current;
        return {
          ...current,
          sessions: current.sessions.map((session) =>
            session.id === openedSession.id ? openedSession : session,
          ),
        };
      });
    },
    [queryClient, sessionsQueryKey],
  );

  const addStep = () => {
    setSpawnSteps((prev) => [...prev, { id: Date.now(), value: "" }]);
  };
  const removeStep = (id: number) => {
    setSpawnSteps((prev) => prev.filter((s) => s.id !== id));
  };
  const updateStep = (id: number, value: string) => {
    setSpawnSteps((prev) => prev.map((s) => (s.id === id ? { ...s, value } : s)));
  };

  useEffect(() => {
    const project = spawnProjectId.trim();
    const prompt = spawnPrompt.trim();
    if (!project || !prompt) return;
    // Same gate as submit: while still on the auto-derived workspace mode,
    // an in-flight or failed spawn-defaults request means spawnWorkspaceMode
    // is still the hardcoded "worktree" fallback, not the project's real
    // default. Firing preflight against it would compute a branch suggestion
    // for the wrong mode. Re-runs (and re-debounces) once the defaults settle.
    if (spawnWorkspaceModeUnresolved) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      const overrides = buildSpawnOverrides(spawnWorkspaceMode, spawnDefaultBranch);
      const payload: Record<string, unknown> = {
        projectId: project,
        prompt,
        agent: spawnAgent,
        overrides,
      };

      fetch("/api/preflight", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((result: { branch: string | null } | null) => {
          if (!cancelled && result?.branch && !spawnBranchExplicitRef.current) {
            setSpawnBranch(result.branch);
          }
        })
        .catch(() => {});
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    spawnProjectId,
    spawnPrompt,
    spawnAgent,
    spawnWorkspaceMode,
    spawnDefaultBranch,
    spawnWorkspaceModeUnresolved,
  ]);

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

  const handleSpawn = async () => {
    const nextProjectId = spawnProjectId.trim();
    const nextPrompt = spawnPrompt.trim();
    if (!nextProjectId || spawningRef.current) return;

    spawningRef.current = true;
    setSpawning(true);
    try {
      const payload = buildSpawnSessionPayload({
        projectId: nextProjectId,
        prompt: nextPrompt,
        agent: spawnAgent,
        model: spawnModel,
        mode: effectiveSessionMode,
        attachments: spawnAttachments,
        branch: spawnBranch,
        planMode: spawnPlanMode,
        selfDestruct: spawnSelfDestruct,
        selfDestructConditions: spawnSelfDestructConditions,
        steps: spawnSteps,
        trackerUrl: spawnTrackerUrl,
        workspaceMode: spawnWorkspaceMode,
        defaultBranch: spawnDefaultBranch,
      });

      const response = await fetch("/api/spawn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response, "Failed to spawn Spur session"));
      }
      spawnHistory.saveEntry(nextPrompt);
      const session = (await response.json()) as SpurSessionView;
      clearSpawnDraft();
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
      setSpawnPrompt("");
      setSpawnModel(null);
      setSpawnSessionMode(null);
      setSpawnBranch("");
      spawnBranchExplicitRef.current = false;
      setSpawnPlanMode(false);
      setSpawnSelfDestruct(false);
      setSpawnSelfDestructConditions("");
      setSpawnSteps([]);
      setSpawnWorkspaceModeConfirmedFor(null);
      setSpawnWorkspaceMode("worktree");
      setSpawnDefaultBranch("");
      setSpawnAttachments([]);
      setSpawnPinnedProjectId(null);
      setSpawnTrackerUrl(null);
      setSpawnOpen(false);
      syncSpawnProject(nextProjectId);
    } catch (spawnError) {
      showErrorToast(errorMessage(spawnError, "Failed to spawn Spur session"));
    } finally {
      spawningRef.current = false;
      setSpawning(false);
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
    setNewProjectSubmitting(true);
    setNewProjectError(null);
    if (createMissing) setNewProjectMissingPath(null);
    try {
      const body: CreateProjectRequest = { displayName, prefix };
      if (path) body.path = path;
      if (createMissing) body.createMissing = true;
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
      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response, "Failed to restore Spur session"));
      }
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

  const handleCompleteSession = async (
    session: DashboardSession,
    options?: {
      prAction?: OpenPrAction;
      retry?: true;
      skipPrCheck?: true;
    },
  ): Promise<boolean> => {
    const prAction = options?.prAction;
    const activeDeskSessions = sameDeskActiveSessions(allSessions, session);
    const activeSubagentCount = activeDeskSessions.filter(
      (candidate) => candidate.id !== session.id,
    ).length;
    // A dialog retry is the same Done click the user already confirmed.
    if (!options?.retry && activeSubagentCount > 0 && typeof window !== "undefined") {
      const ok = window.confirm(
        `Complete this desk? ${activeSubagentCount} subagent${
          activeSubagentCount === 1 ? "" : "s"
        } on this checkout will be ended.`,
      );
      if (!ok) return false;
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
      const body = {
        scope: "desk",
        ...(prAction ? { prAction } : {}),
        ...(options?.skipPrCheck ? { skipPrCheck: true } : {}),
      };
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
          // Only one dashboard dialog is ever mounted.
          setPrCheckUnavailable(null);
          setOpenPrAction({ session, payload });
          return false;
        }
        if (isGithubPrCheckUnavailablePayload(payload)) {
          if (previousResponse) {
            queryClient.setQueryData<SpurSessionsResponse>(sessionsQueryKey, previousResponse);
          }
          // The two PR dialogs are alternatives for one complete attempt. Leaving
          // the sibling mounted stacks both, and the stale one survives a later
          // success and re-fires /complete on a terminal session.
          setOpenPrAction(null);
          setPrCheckUnavailable({ session, payload });
          return false;
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
      return true;
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
      // Clear only on a real completion: a second failure re-opens a dialog,
      // and dismissing it here would drop the user back to a bare row.
      if (await handleCompleteSession(openPrAction.session, { prAction, retry: true })) {
        setOpenPrAction(null);
      }
    } catch {
      // handleCompleteSession already toasted; keep the dialog reachable.
    } finally {
      setOpenPrActionBusy(false);
    }
  };

  const handlePrCheckUnavailable = async (options: { skipPrCheck?: true }) => {
    if (!prCheckUnavailable) return;
    setPrCheckUnavailableBusy(true);
    try {
      if (await handleCompleteSession(prCheckUnavailable.session, { ...options, retry: true })) {
        setPrCheckUnavailable(null);
      }
    } catch {
      // handleCompleteSession already toasted. Keep the dialog open so Skip
      // stays reachable instead of dropping the user back to a bare row.
    } finally {
      setPrCheckUnavailableBusy(false);
    }
  };

  const openSpawnModal = () => {
    setSpawnPinnedProjectId(null);
    applySpawnDraft(resolvePreferredSpawnProjectId(), readSpawnDraft());
    setSpawnOpen(true);
  };

  const openShepherdSpawnModal = () => {
    setSpawnPinnedProjectId(SHEPHERD_PROJECT_ID);
    applySpawnDraft(SHEPHERD_PROJECT_ID, null);
    setSpawnOpen(true);
  };

  const openBacklogSpawnModal = (item: AvailableBacklogItem) => {
    setSpawnPinnedProjectId(null);
    const draft = readSpawnDraft();
    if (draft?.trackerUrl === item.url) {
      applySpawnDraft(item.projectId, draft);
    } else {
      applySpawnDraft(item.projectId, null);
      setSpawnPrompt(`Work on ${item.key}: ${item.title}\n\n${item.url}`);
      setSpawnTrackerUrl(item.url);
    }
    setSpawnOpen(true);
  };

  const addSpawnFiles = useCallback(
    (files: FileList | File[] | null) => {
      void fileAttachmentsFromFiles(files)
        .then((attachments) => {
          if (attachments.length === 0) return;
          let rejectedMessage: string | null = null;
          setSpawnAttachments((current) => {
            const result = mergeAttachmentsWithinLimit(current, attachments);
            rejectedMessage = result.rejectedMessage;
            return result.attachments;
          });
          if (rejectedMessage) showErrorToast(rejectedMessage);
        })
        .catch(() => {});
    },
    [showErrorToast],
  );

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
    if (!terminalSession) return;
    void markSessionOpened(terminalSession.id).catch(() => {});
  }, [markSessionOpened, terminalSession?.id]);

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
      if (spawnOpen || newProjectOpen || terminalSession || openPrAction || prCheckUnavailable)
        return;

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
  }, [newProjectOpen, openPrAction, prCheckUnavailable, spawnOpen, terminalSession]);

  return (
    <TagsContext.Provider value={tagsContextValue}>
      <div className="flex min-h-dvh flex-col">
        <header className="sticky top-0 z-40 border-b border-[var(--color-border-default)] bg-[var(--color-bg-base)]">
          <div className="mx-auto flex min-h-10 max-w-[1500px] items-center gap-2.5 px-4 py-[7px] sm:px-5 lg:px-6">
            <BrandGlyph />
            <span className="hidden min-w-0 md:inline-flex">
              <ProjectMenu
                activeProjectName={activeProjectName}
                projects={filterProjectOptions}
                selectedProjectId={projectId}
                onSelectProject={syncProjectFilter}
                onNewProject={openNewProjectModal}
                onEdit={openEditProjectModal}
              />
            </span>
            <button
              aria-label="Filters"
              className={`inline-flex h-7 shrink-0 items-center gap-[7px] border px-[9px] uppercase tracking-[0.08em] transition ${
                activeFilterCount > 0
                  ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                  : "border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)]"
              }`}
              onClick={() => setFiltersOpen(true)}
              type="button"
            >
              <IconSliders />
              <span className="hidden text-[10px] md:inline">Filters</span>
              {activeFilterCount > 0 ? (
                <span className="min-w-4 border border-[var(--color-accent)] px-1 text-center font-bold tabular-nums">
                  {activeFilterCount}
                </span>
              ) : null}
            </button>
            <div className="relative flex min-w-0 max-w-[32rem] flex-1 items-center">
              <div className="flex h-7 min-w-0 flex-1 items-center gap-[7px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 focus-within:border-[var(--color-accent)]">
                <svg
                  aria-hidden="true"
                  className="h-[13px] w-[13px] shrink-0 text-[var(--color-text-tertiary)]"
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
                  placeholder={voicePlaceholder("Filter...", searchVoice)}
                  ref={searchInputRef}
                  value={searchQuery}
                />
                {searchQuery.length > 0 ? (
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
                ) : null}
                {searchVoice.canUseVoice ? (
                  <VoiceControls
                    borderless
                    className={DASHBOARD_SEARCH_TOOL_BUTTON_CLASS}
                    groupClassName="flex items-center gap-1"
                    voice={searchVoice}
                  />
                ) : null}
              </div>
              {searchVoice.voiceError ? (
                <div
                  className="absolute left-0 top-full z-10 mt-1 w-full border border-[var(--color-chip-error-border)] bg-[var(--color-chip-error-bg)] px-2 py-1.5 text-[10px] text-[var(--color-chip-error-text)]"
                  role="alert"
                >
                  {searchVoice.voiceError}
                </div>
              ) : searchVoice.recording || searchVoice.voiceBusy ? (
                <div className="absolute left-0 top-full z-10 mt-1 px-2 text-[10px] text-[var(--color-text-tertiary)]">
                  <VoiceStatusHint voice={searchVoice} />
                </div>
              ) : null}
            </div>
            {hasActiveFilters ? (
              <button
                aria-label="Reset all filters"
                className="h-7 shrink-0 border border-[var(--color-border-default)] px-2 uppercase text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                onClick={resetAllFilters}
                type="button"
              >
                Reset
              </button>
            ) : null}
            <button
              aria-label="Spawn Shepherd"
              className="ml-auto inline-flex h-7 w-7 shrink-0 items-center justify-center border border-[var(--color-border-default)] bg-transparent text-[var(--color-text-secondary)] transition hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)]"
              onClick={openShepherdSpawnModal}
              title="Spawn Shepherd"
              type="button"
            >
              <IconShepherd />
            </button>
            {!isMobile ? (
              <button
                className="inline-flex h-7 shrink-0 items-center gap-[7px] whitespace-nowrap border border-[var(--color-accent)] bg-[var(--color-accent)] px-[11px] font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)]"
                onClick={openSpawnModal}
                type="button"
              >
                <IconPlus className="h-3 w-3" />
                Spawn Session
              </button>
            ) : null}
          </div>
        </header>

        {isMobile && !spawnOpen && !terminalSession ? (
          <button
            aria-label="Spawn Session"
            className="fixed bottom-[38px] right-3.5 z-[35] flex h-12 w-12 items-center justify-center rounded-[14px] border border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-text-inverse)] shadow-[0_6px_20px_var(--color-shadow-modal-lg)] transition hover:bg-[var(--color-accent-hover)]"
            onClick={openSpawnModal}
            type="button"
          >
            <IconPlus className="h-4 w-4" />
          </button>
        ) : null}

        {filtersOpen ? (
          <FiltersModal
            activeFilterCount={activeFilterCount}
            activeStatFilter={activeStatFilter}
            activeTagFilters={activeTagFilters}
            agentFilter={agentFilter}
            agentOptions={AGENT_OPTIONS.map((agent) => ({
              id: agent,
              count: agentCounts.get(agent) ?? 0,
            }))}
            allAgentsCount={allAgentsCount}
            allProjectsCount={allProjectsCount}
            allStatusesCount={allStatusesCount}
            allTagsCount={allTagsCount}
            onClearAgents={clearAgentFilters}
            onClearAll={resetAllFilters}
            onClearTags={clearTagFilters}
            onClose={() => setFiltersOpen(false)}
            onPrReadyOnlyChange={setPrReadyOnly}
            onSelectProject={syncProjectFilter}
            onSelectStatus={selectStatFilter}
            onToggleAgent={toggleAgentFilter}
            onToggleTag={(tag) =>
              setActiveTagFilters((current) =>
                current.includes(tag) ? current.filter((name) => name !== tag) : [...current, tag],
              )
            }
            prReadyCount={prReadyCount}
            prReadyLoaded={prReady.loaded}
            prReadyOnly={prReadyOnly}
            projectId={projectId}
            projectOptions={filterProjectOptions.map((project) => ({
              id: project.id,
              name: project.name,
              count: projectCounts.get(project.id) ?? 0,
            }))}
            statusOptions={ATTENTION_ZONE_ORDER.map((level) => ({
              level,
              label: ATTENTION_LANE_META[level].label,
              color: ATTENTION_LANE_META[level].color,
              icon: STATUS_LANE_ICONS[level],
              count: stats[level],
            }))}
            tagOptions={filterTagCatalog.map((tag) => ({
              name: tag.name,
              color: tag.color,
              count: tagCounts.get(tag.name) ?? 0,
            }))}
          />
        ) : null}

        <main className="mx-auto flex w-full max-w-[1500px] flex-1 flex-col px-4 py-4 pb-8 sm:px-5 lg:px-6">
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
              history={{
                entries: spawnHistory.entries,
                onSelect: (next) => {
                  setSpawnPrompt(next);
                },
              }}
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
                model: {
                  value: spawnModel,
                  onChange: (next) => {
                    setSpawnModel(next);
                  },
                  spawnDefaults,
                  carry: null,
                  onResolvedChange: (resolved, error) => {
                    setSpawnModelResolved(resolved);
                    setSpawnModelError(error);
                  },
                },
                ...(spawnModeOptions.length > 0
                  ? {
                      sessionMode: {
                        value: effectiveSessionMode ?? "",
                        onChange: (next: string) => {
                          setSpawnSessionMode(next === "" ? null : next);
                        },
                        options: spawnModeOptions,
                      },
                    }
                  : {}),
                branch: {
                  value: spawnBranch,
                  onChange: (next) => {
                    spawnBranchExplicitRef.current = next.trim().length > 0;
                    setSpawnBranch(next);
                  },
                  onBlur: () => {
                    const normalizedBranch = normalizeBranchName(spawnBranch);
                    spawnBranchExplicitRef.current = normalizedBranch.length > 0;
                    setSpawnBranch(normalizedBranch);
                  },
                },
                workspaceMode: {
                  value: spawnWorkspaceMode,
                  onChange: (next) => {
                    setSpawnWorkspaceModeConfirmedFor(spawnProjectId);
                    setSpawnWorkspaceMode(next);
                  },
                },
                planMode: {
                  value: spawnPlanMode,
                  onChange: (next) => {
                    setSpawnPlanMode(next);
                  },
                },
                selfDestruct: {
                  value: spawnSelfDestruct,
                  onChange: (next) => {
                    setSpawnSelfDestruct(next);
                  },
                },
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
                    {spawnWorkspaceModeAuto && spawnDefaults.error ? (
                      <div className="flex flex-wrap items-center gap-2 border border-[var(--color-chip-error-border)] bg-[var(--color-chip-error-bg)] px-2.5 py-1.5 text-xs text-[var(--color-chip-error-text)]">
                        <span>
                          couldn&apos;t resolve this project&apos;s workspace default:{" "}
                          {spawnDefaults.error}
                        </span>
                        <span className="flex gap-2">
                          <button
                            className="border border-[var(--color-chip-error-border)] px-2 py-1 font-bold uppercase text-[var(--color-chip-error-text)] transition hover:bg-[var(--color-chip-error-border)]/20"
                            onClick={() => {
                              setSpawnWorkspaceModeConfirmedFor(spawnProjectId);
                              setSpawnWorkspaceMode("worktree");
                            }}
                            type="button"
                          >
                            Use worktree
                          </button>
                          <button
                            className="border border-[var(--color-chip-error-border)] px-2 py-1 font-bold uppercase text-[var(--color-chip-error-text)] transition hover:bg-[var(--color-chip-error-border)]/20"
                            onClick={() => {
                              setSpawnWorkspaceModeConfirmedFor(spawnProjectId);
                              setSpawnWorkspaceMode("shared");
                            }}
                            type="button"
                          >
                            Use shared
                          </button>
                        </span>
                      </div>
                    ) : null}
                    {spawnModelError ? (
                      <div className="border border-[var(--color-chip-error-border)] bg-[var(--color-chip-error-bg)] px-2.5 py-1.5 text-xs text-[var(--color-chip-error-text)]">
                        couldn&apos;t load the model catalog: {spawnModelError}
                      </div>
                    ) : null}
                  </>
                ),
                selfDestructSlot: spawnSelfDestruct ? (
                  <textarea
                    aria-label="Self-destruct conditions"
                    className={`min-h-20 w-full resize-y ${INPUT_CLASS}`}
                    onChange={(event) => {
                      setSpawnSelfDestructConditions(event.target.value);
                    }}
                    placeholder={`Leave empty for default: ${DEFAULT_SELF_DESTRUCT_CONDITION}`}
                    value={spawnSelfDestructConditions}
                  />
                ) : null,
                baseBranchSlot:
                  spawnWorkspaceMode === "worktree" ? (
                    <input
                      className={`w-full ${INPUT_CLASS}`}
                      onChange={(event) => {
                        setSpawnDefaultBranch(event.target.value);
                      }}
                      placeholder="Base branch"
                      value={spawnDefaultBranch}
                    />
                  ) : null,
              }}
              onAddFiles={addSpawnFiles}
              onAgentChange={(next) => {
                setSpawnAgent(next);
                setSpawnModel(null);
              }}
              onClose={closeSpawnModal}
              onPromptChange={(next) => {
                setSpawnPrompt(next);
              }}
              onRemoveAttachment={(index) => {
                setSpawnAttachments((current) =>
                  current.filter((_, currentIndex) => currentIndex !== index),
                );
              }}
              onSubmit={() => void handleSpawn()}
              prompt={spawnPrompt}
              promptAriaLabel="Prompt..."
              promptMinHeightClass="min-h-[24rem] sm:min-h-[28rem]"
              promptPlaceholder="Prompt..."
              promptRef={spawnPromptRef}
              showCancel={false}
              slashEndpoint={
                spawnProjectId.trim()
                  ? `/api/projects/${encodeURIComponent(spawnProjectId.trim())}/slash-commands?agent=${encodeURIComponent(spawnAgent)}`
                  : null
              }
              submitBusyAriaLabel="Spawning session"
              submitDisabled={
                spawning ||
                !spawnProjectId.trim() ||
                !spawnModelResolved ||
                spawnWorkspaceModeUnresolved
              }
              submitLabel="Spawn"
              submitting={spawning}
              title="Spawn Session"
              voice={voice}
            />
          ) : null}

          {loading ? <CenteredLoader className="flex-1" label="Loading dashboard" /> : null}

          {!loading && !hasVisibleSessions && !hasVisibleBacklog ? (
            <section className="mt-5">
              <EmptyState message={emptyStateMessage} />
              {hasActiveFilters ? (
                <div className="mt-3 flex justify-center">
                  <button
                    className="border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                    onClick={resetAllFilters}
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
                  onTake={openBacklogSpawnModal}
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
          {prCheckUnavailable ? (
            <GithubRateLimitDialog
              busy={prCheckUnavailableBusy}
              onCancel={() => setPrCheckUnavailable(null)}
              onRetry={() => void handlePrCheckUnavailable({})}
              onSkip={() => void handlePrCheckUnavailable({ skipPrCheck: true })}
              payload={prCheckUnavailable.payload}
            />
          ) : null}
        </main>
        <ToastViewport toasts={toasts} onDismiss={dismissToast} />
        <StatusBar />
      </div>
    </TagsContext.Provider>
  );
}
