"use client";

import { useEffect, type ReactNode } from "react";
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
  projectOptions: FiltersModalProjectOption[];
  allProjectsCount: number;
  projectId: string;
  onSelectProject: (projectId: string) => void;
  agentOptions: FiltersModalAgentOption[];
  agentFilter: AgentName[];
  onToggleAgent: (agent: AgentName) => void;
  tagOptions: FiltersModalTagOption[];
  activeTagFilters: string[];
  onToggleTag: (tag: string) => void;
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
  projectOptions,
  allProjectsCount,
  projectId,
  onSelectProject,
  agentOptions,
  agentFilter,
  onToggleAgent,
  tagOptions,
  activeTagFilters,
  onToggleTag,
  activeFilterCount,
  onClearAll,
}: FiltersModalProps) {
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
      aria-labelledby="filters-modal-title"
      aria-modal="true"
      className="fixed inset-0 z-[85] flex items-start justify-center bg-[var(--color-modal-backdrop)] px-4 pb-4 pt-11"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
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
              <button
                aria-pressed={activeStatFilter === null}
                className={optionClass(activeStatFilter === null)}
                onClick={() => onSelectStatus(null)}
                type="button"
              >
                <span>All statuses:</span>
                <span className="font-bold tabular-nums">{allStatusesCount}</span>
              </button>
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
            <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-2">
              <button
                aria-pressed={prReadyOnly}
                className={optionClass(prReadyOnly)}
                onClick={() => onPrReadyOnlyChange(!prReadyOnly)}
                title="GitHub only"
                type="button"
              >
                <span>Ready to merge</span>
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <SectionLabel>Project</SectionLabel>
            <div className="flex flex-wrap gap-2">
              <button
                aria-pressed={projectId === ""}
                className={optionClass(projectId === "")}
                onClick={() => onSelectProject("")}
                type="button"
              >
                <span>All:</span>
                <span className="font-bold tabular-nums">{allProjectsCount}</span>
              </button>
              {projectOptions.map((project) => (
                <button
                  aria-pressed={projectId === project.id}
                  className={optionClass(projectId === project.id)}
                  key={project.id}
                  onClick={() => onSelectProject(project.id)}
                  type="button"
                >
                  <span>{project.name}:</span>
                  <span className="font-bold tabular-nums">{project.count}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <SectionLabel>Agent</SectionLabel>
            <div className="flex flex-wrap gap-2">
              {agentOptions.map((agent) => (
                <button
                  aria-pressed={agentFilter.includes(agent.id)}
                  className={optionClass(agentFilter.includes(agent.id))}
                  key={agent.id}
                  onClick={() => onToggleAgent(agent.id)}
                  type="button"
                >
                  <span>{getAgentDisplayName(agent.id)}:</span>
                  <span className="font-bold tabular-nums">{agent.count}</span>
                </button>
              ))}
            </div>
          </div>

          {tagOptions.length > 0 ? (
            <div className="flex flex-col gap-2">
              <SectionLabel>Tags</SectionLabel>
              <div className="flex flex-wrap gap-2">
                {tagOptions.map((tag) => {
                  const selected = activeTagFilters.includes(tag.name);
                  return (
                    <button
                      aria-pressed={selected}
                      className={optionClass(selected)}
                      key={tag.name}
                      onClick={() => onToggleTag(tag.name)}
                      style={selected ? undefined : tagChipStyle(tag.color)}
                      type="button"
                    >
                      <span>{tag.name}:</span>
                      <span className="font-bold tabular-nums">{tag.count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-[var(--color-border-default)] px-[13px] py-2">
          <span className="text-[var(--color-text-secondary)]">
            {activeFilterCount} filters applied
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
