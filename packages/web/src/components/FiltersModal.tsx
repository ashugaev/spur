"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { getAgentDisplayName, type AgentName } from "@/lib/agents";
import { tagChipStyle } from "@/lib/tag-style";
import type { AttentionLevel } from "@/lib/types";

const OPTION_BASE_CLASS =
  "flex items-center gap-1.5 border px-2.5 py-1.5 text-left uppercase transition";
const OPTION_SELECTED_CLASS =
  "border-[var(--color-accent)] bg-[var(--color-hover-overlay)] text-[var(--color-accent)]";
const OPTION_UNSELECTED_CLASS =
  "border-[var(--color-border-default)] bg-transparent text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)]";

function optionClass(selected: boolean): string {
  return `${OPTION_BASE_CLASS} ${selected ? OPTION_SELECTED_CLASS : OPTION_UNSELECTED_CLASS}`;
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-tertiary)]">
      {children}
    </span>
  );
}

function SectionHeader({
  label,
  resetLabel,
  showReset,
  onReset,
}: {
  label: ReactNode;
  resetLabel: string;
  showReset: boolean;
  onReset: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <SectionLabel>{label}</SectionLabel>
      {showReset ? (
        <button
          className="uppercase text-[var(--color-text-tertiary)] transition hover:text-[var(--color-text-primary)]"
          onClick={onReset}
          type="button"
        >
          {resetLabel}
        </button>
      ) : null}
    </div>
  );
}

// The "<label>: <count>" chip shared by the All chips and every Project,
// Agent, and Tag option. Status and PR-ready chips carry an icon and dimming
// of their own and stay hand-rolled on `optionClass`.
function FacetChip({
  count,
  label,
  onClick,
  selected,
  style,
}: {
  count: number;
  label: string;
  onClick: () => void;
  selected: boolean;
  style?: CSSProperties;
}) {
  return (
    <button
      aria-pressed={selected}
      className={optionClass(selected)}
      onClick={onClick}
      style={style}
      type="button"
    >
      <span>{label}:</span>
      <span className="font-bold tabular-nums">{count}</span>
    </button>
  );
}

function IconMergeReady() {
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

export interface FiltersModalStatusOption {
  level: AttentionLevel;
  label: string;
  color: string;
  icon: ReactNode;
  count: number;
}

export interface FiltersModalProjectOption {
  id: string;
  name: string;
  count: number;
}

export interface FiltersModalAgentOption {
  id: AgentName;
  count: number;
}

export interface FiltersModalTagOption {
  name: string;
  color: string;
  count: number;
}

export interface FiltersModalProps {
  onClose: () => void;
  statusOptions: FiltersModalStatusOption[];
  allStatusesCount: number;
  activeStatFilter: AttentionLevel | null;
  onSelectStatus: (level: AttentionLevel | null) => void;
  prReadyOnly: boolean;
  onPrReadyOnlyChange: (value: boolean) => void;
  prReadyCount: number;
  prReadyLoaded: boolean;
  projectOptions: FiltersModalProjectOption[];
  allProjectsCount: number;
  projectId: string;
  onSelectProject: (projectId: string) => void;
  agentOptions: FiltersModalAgentOption[];
  allAgentsCount: number;
  agentFilter: AgentName[];
  onToggleAgent: (agent: AgentName) => void;
  onClearAgents: () => void;
  tagOptions: FiltersModalTagOption[];
  allTagsCount: number;
  activeTagFilters: string[];
  onToggleTag: (tag: string) => void;
  onClearTags: () => void;
  activeFilterCount: number;
  onClearAll: () => void;
}

export function FiltersModal({
  onClose,
  statusOptions,
  allStatusesCount,
  activeStatFilter,
  onSelectStatus,
  prReadyOnly,
  onPrReadyOnlyChange,
  prReadyCount,
  prReadyLoaded,
  projectOptions,
  allProjectsCount,
  projectId,
  onSelectProject,
  agentOptions,
  allAgentsCount,
  agentFilter,
  onToggleAgent,
  onClearAgents,
  tagOptions,
  allTagsCount,
  activeTagFilters,
  onToggleTag,
  onClearTags,
  activeFilterCount,
  onClearAll,
}: FiltersModalProps) {
  // Toggle on but no snapshot yet gets the extra "unavailable" hint (title +
  // dimmed chrome); either state with no snapshot dims the count itself so
  // "0" never reads as a computed answer before one exists.
  const prReadyUnavailable = prReadyOnly && !prReadyLoaded;
  const prReadyDimmed = !prReadyLoaded || prReadyCount === 0;

  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Initial focus inside the dialog so Tab can't reach the page behind it
    // before the user interacts with the modal at all.
    dialogRef.current?.querySelector<HTMLElement>("button, [href], input, [tabindex]")?.focus();
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button, [href], input, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled"));
      if (focusable.length === 0) return;
      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      if (event.shiftKey) {
        if (document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      aria-labelledby="filters-modal-title"
      aria-modal="true"
      className="fixed inset-0 z-[85] flex items-start justify-center bg-[var(--color-modal-backdrop)] px-4 pb-4 pt-11"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      ref={dialogRef}
      role="dialog"
    >
      <div className="flex max-h-[80vh] w-[min(560px,100%)] flex-col border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)]">
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border-default)] px-[13px] py-2">
          <h2
            className="font-bold uppercase tracking-[0.1em] text-[var(--color-text-primary)]"
            id="filters-modal-title"
          >
            Filters
          </h2>
          <button
            aria-label="Close filters"
            className="uppercase text-[var(--color-text-tertiary)] transition hover:text-[var(--color-text-primary)]"
            onClick={onClose}
            type="button"
          >
            esc
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-[13px]">
          <div className="flex flex-col gap-2">
            <SectionLabel>Status</SectionLabel>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-2">
              <FacetChip
                count={allStatusesCount}
                label="All statuses"
                onClick={() => onSelectStatus(null)}
                selected={activeStatFilter === null}
              />
              {statusOptions.map((option) => (
                <button
                  aria-pressed={activeStatFilter === option.level}
                  className={optionClass(activeStatFilter === option.level)}
                  key={option.level}
                  onClick={() => onSelectStatus(option.level)}
                  type="button"
                >
                  <span
                    style={{
                      color: option.count > 0 ? option.color : "var(--color-text-tertiary)",
                    }}
                  >
                    {option.icon}
                  </span>
                  <span
                    style={option.count > 0 ? undefined : { color: "var(--color-text-tertiary)" }}
                  >
                    {option.label}:
                  </span>
                  <span
                    className="font-bold tabular-nums"
                    style={option.count > 0 ? undefined : { color: "var(--color-text-tertiary)" }}
                  >
                    {option.count}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <SectionLabel>Pull request</SectionLabel>
            {/* flex-wrap, not the auto-fit grid used by Status: with only one
                button, an auto-fit grid track stretches to the full
                container width and renders as a full-width bar instead of a
                chip sized like its siblings. */}
            <div className="flex flex-wrap gap-2">
              <button
                aria-pressed={prReadyOnly}
                className={`${optionClass(prReadyOnly)}${prReadyUnavailable ? " opacity-60" : ""}`}
                onClick={() => onPrReadyOnlyChange(!prReadyOnly)}
                title={prReadyUnavailable ? "GitHub only — status unavailable" : "GitHub only"}
                type="button"
              >
                <span
                  style={{
                    color: prReadyDimmed
                      ? "var(--color-text-tertiary)"
                      : "var(--color-status-ready)",
                  }}
                >
                  <IconMergeReady />
                </span>
                <span style={prReadyDimmed ? { color: "var(--color-text-tertiary)" } : undefined}>
                  Ready to merge:
                </span>
                <span
                  className="font-bold tabular-nums"
                  style={prReadyDimmed ? { color: "var(--color-text-tertiary)" } : undefined}
                >
                  {prReadyLoaded ? prReadyCount : "–"}
                </span>
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <SectionLabel>Project</SectionLabel>
            <div className="flex flex-wrap gap-2">
              <FacetChip
                count={allProjectsCount}
                label="All"
                onClick={() => onSelectProject("")}
                selected={projectId === ""}
              />
              {projectOptions.map((project) => (
                <FacetChip
                  count={project.count}
                  key={project.id}
                  label={project.name}
                  onClick={() => onSelectProject(project.id)}
                  selected={projectId === project.id}
                />
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <SectionHeader
              label="Agent"
              onReset={onClearAgents}
              resetLabel="Reset agent filters"
              showReset={agentFilter.length > 0}
            />
            <div className="flex flex-wrap gap-2">
              <FacetChip
                count={allAgentsCount}
                label="All agents"
                onClick={onClearAgents}
                selected={agentFilter.length === 0}
              />
              {agentOptions.map((agent) => (
                <FacetChip
                  count={agent.count}
                  key={agent.id}
                  label={getAgentDisplayName(agent.id)}
                  onClick={() => onToggleAgent(agent.id)}
                  selected={agentFilter.includes(agent.id)}
                />
              ))}
            </div>
          </div>

          {tagOptions.length > 0 ? (
            <div className="flex flex-col gap-2">
              <SectionHeader
                label="Tags"
                onReset={onClearTags}
                resetLabel="Reset tag filters"
                showReset={activeTagFilters.length > 0}
              />
              <div className="flex flex-wrap gap-2">
                <FacetChip
                  count={allTagsCount}
                  label="All tags"
                  onClick={onClearTags}
                  selected={activeTagFilters.length === 0}
                />
                {tagOptions.map((tag) => {
                  const selected = activeTagFilters.includes(tag.name);
                  return (
                    <FacetChip
                      count={tag.count}
                      key={tag.name}
                      label={tag.name}
                      onClick={() => onToggleTag(tag.name)}
                      selected={selected}
                      style={selected ? undefined : tagChipStyle(tag.color)}
                    />
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-[var(--color-border-default)] px-[13px] py-2">
          <span className="text-[var(--color-text-secondary)]">
            {activeFilterCount} filter{activeFilterCount === 1 ? "" : "s"} applied
          </span>
          <div className="flex items-center gap-2">
            <button
              className="border border-[var(--color-border-default)] px-2.5 py-1.5 uppercase text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              onClick={onClearAll}
              type="button"
            >
              clear all
            </button>
            <button
              className="bg-[var(--color-accent)] px-2.5 py-1.5 font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)]"
              onClick={onClose}
              type="button"
            >
              done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
