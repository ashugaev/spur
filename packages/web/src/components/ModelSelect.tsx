"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FavoriteIcon } from "@/components/icons/FavoriteIcon";
import { INPUT_CLASS } from "@/design/classes";
import { useAnchoredMenu } from "@/hooks/useAnchoredMenu";
import { useFavorites } from "@/hooks/useFavorites";
import { cn } from "@/lib/cn";
import type { AgentName } from "@/lib/agents";
import type { AgentModel, AgentModelsResponse } from "@/lib/types";

const FAVORITES_STORAGE_KEY = "spur:model-favorites";

interface ModelSelectProps {
  agent: AgentName;
  value: string | null;
  onChange: (id: string | null) => void;
  ariaLabel?: string;
  // When true, auto-selects a model once the list loads and no value is set:
  // the alphabetically-first favorited model, else the first model in the
  // fetched list. Off by default so respawn/handoff/Shepherd stay on Default.
  preselectWhenEmpty?: boolean;
  // Fired only from direct user clicks (Default / a model row), never from
  // the programmatic clear-on-agent-change or preselect effects. Lets callers
  // persist user intent without picking up auto-picks.
  onUserSelect?: (id: string | null) => void;
}

function favoriteKey(agent: AgentName, id: string): string {
  return `${agent}:${id}`;
}

// Shared empty-state copy for the button label and the dropdown body, so the
// literals live in exactly one place.
function resolvePendingLabel(loading: boolean, error: string | null): string {
  if (loading) return "Loading…";
  return error ?? "No models";
}

export function ModelSelect({
  agent,
  value,
  onChange,
  ariaLabel = "Model",
  preselectWhenEmpty = false,
  onUserSelect,
}: ModelSelectProps) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<AgentModel[]>([]);
  // Which agent the currently-loaded `models` list belongs to. Guards the
  // stale-value drop and preselect effects below against a race where
  // `agent` (and `value`, seeded by the parent) changes on one render but
  // `models` still holds the PREVIOUS agent's settled list until the new
  // fetch resolves.
  const [modelsAgent, setModelsAgent] = useState<AgentName | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const favorites = useFavorites(FAVORITES_STORAGE_KEY);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetch(`/api/models?agent=${encodeURIComponent(agent)}`)
      .then(async (response) => {
        const payload = (await response.json()) as AgentModelsResponse | { error?: string };
        if (cancelled) return;
        if (!response.ok || !("models" in payload)) {
          const message =
            "error" in payload && payload.error ? payload.error : "Failed to load models";
          setError(message);
          setModels([]);
          return;
        }
        setModels(payload.models);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load models");
        setModels([]);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setModelsAgent(agent);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agent]);

  // If the current selection is not part of the freshly loaded list, drop it.
  // Gated on modelsAgent === agent so this only evaluates once `models`
  // actually belongs to the current agent, not a stale list left over from
  // the agent just switched away from.
  useEffect(() => {
    if (
      value !== null &&
      !loading &&
      modelsAgent === agent &&
      models.length > 0 &&
      !models.some((m) => m.id === value)
    ) {
      onChangeRef.current(null);
    }
  }, [models, modelsAgent, agent, loading, value]);

  const isFavorite = (model: AgentModel) => favorites.has(favoriteKey(agent, model.id));

  // Auto-select once the list loads with nothing chosen yet: the
  // alphabetically-first favorited model, else the first list entry.
  useEffect(() => {
    if (
      !preselectWhenEmpty ||
      value !== null ||
      loading ||
      error ||
      modelsAgent !== agent ||
      models.length === 0
    )
      return;
    const favoriteModels = models
      .filter((m) => favorites.has(favoriteKey(agent, m.id)))
      .map((m) => m.id)
      .sort();
    onChangeRef.current(favoriteModels[0] ?? models[0].id);
  }, [preselectWhenEmpty, value, loading, error, modelsAgent, models, favorites.keys, agent]);

  const orderedModels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? models.filter(
          (m) => m.id.toLowerCase().includes(needle) || m.label.toLowerCase().includes(needle),
        )
      : models;
    const favoriteModels = filtered.filter(isFavorite);
    const rest = filtered.filter((m) => !isFavorite(m));
    return [...favoriteModels, ...rest];
  }, [models, query, favorites.keys, agent]);

  const { containerRef, buttonRef, menuRef, menuStyle } = useAnchoredMenu({
    open,
    onClose: () => setOpen(false),
    contentDeps: [loading, error, orderedModels],
  });

  const selectedLabel =
    value !== null
      ? (models.find((m) => m.id === value)?.label ?? value)
      : !preselectWhenEmpty
        ? "Default"
        : resolvePendingLabel(loading, error);

  return (
    <div className="relative" ref={containerRef}>
      <button
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        ref={buttonRef}
        className={cn(INPUT_CLASS, "flex w-full items-center justify-between gap-2 text-left")}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="truncate">{selectedLabel}</span>
        <span aria-hidden="true" className="text-[var(--color-text-tertiary)]">
          ▾
        </span>
      </button>
      {open ? (
        <div
          aria-label="Model options"
          className="fixed z-20 flex max-h-80 w-max min-w-[min(20rem,calc(100vw-1rem))] max-w-[calc(100vw-1rem)] flex-col overflow-hidden border border-[var(--color-border-strong)] bg-[var(--color-bg-base)] p-1 shadow-[0_8px_30px_var(--color-shadow-menu)]"
          ref={menuRef}
          role="menu"
          style={menuStyle}
        >
          <input
            aria-label="Search models"
            autoFocus
            className={cn(INPUT_CLASS, "m-1")}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models"
            type="text"
            value={query}
          />
          <div className="flex flex-col overflow-y-auto overflow-x-hidden">
            {preselectWhenEmpty ? null : (
              <button
                className={cn(
                  "flex w-full items-center border-b border-[var(--color-border-subtle)] px-2 py-2 text-left transition hover:bg-[var(--color-hover-overlay)]",
                  value === null
                    ? "text-[var(--color-accent)]"
                    : "text-[var(--color-text-primary)]",
                )}
                onClick={() => {
                  onChange(null);
                  onUserSelect?.(null);
                  setOpen(false);
                }}
                role="menuitem"
                type="button"
              >
                <span className="font-bold">Default</span>
              </button>
            )}
            {loading || error || orderedModels.length === 0 ? (
              <div
                className={cn(
                  "px-2 py-2 text-[10px] uppercase tracking-[0.1em]",
                  error ? "text-[var(--color-status-error)]" : "text-[var(--color-text-tertiary)]",
                )}
              >
                {resolvePendingLabel(loading, error)}
              </div>
            ) : (
              orderedModels.map((model) => {
                const favorite = isFavorite(model);
                return (
                  <div
                    className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-2 border-b border-[var(--color-border-subtle)] last:border-b-0 hover:bg-[var(--color-hover-overlay)]"
                    key={model.id}
                  >
                    <button
                      aria-label={`${favorite ? "Remove favorite" : "Add favorite"} ${model.label}`}
                      aria-pressed={favorite}
                      className={cn(
                        "self-start px-2 py-2 transition",
                        favorite
                          ? "text-[var(--color-status-attention)]"
                          : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]",
                      )}
                      onClick={(event) => {
                        event.stopPropagation();
                        favorites.toggle(favoriteKey(agent, model.id));
                      }}
                      title={`${favorite ? "Remove favorite" : "Add favorite"} ${model.label}`}
                      type="button"
                    >
                      <FavoriteIcon active={favorite} />
                    </button>
                    <button
                      className={cn(
                        "min-w-0 py-2 text-left transition",
                        value === model.id
                          ? "text-[var(--color-accent)]"
                          : "text-[var(--color-text-primary)]",
                      )}
                      onClick={() => {
                        onChange(model.id);
                        onUserSelect?.(model.id);
                        setOpen(false);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <span className="block truncate font-bold" title={model.label}>
                        {model.label}
                      </span>
                      <span
                        className="block truncate text-[10px] text-[var(--color-text-secondary)]"
                        title={model.id}
                      >
                        {model.id}
                      </span>
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
