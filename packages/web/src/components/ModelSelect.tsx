"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FavoriteIcon } from "@/components/icons/FavoriteIcon";
import { INPUT_CLASS } from "@/design/classes";
import { useAnchoredMenu } from "@/hooks/useAnchoredMenu";
import { useFavorites } from "@/hooks/useFavorites";
import { cn } from "@/lib/cn";
import type { AgentName } from "@/lib/agents";
import {
  resolvePreselectedModelId,
  useResolvedSpawnDefaults,
  type CarrySpawnModel,
} from "@/lib/spawn-defaults";
import type { AgentModel, AgentModelsResponse } from "@/lib/types";

const FAVORITES_STORAGE_KEY = "spur:model-favorites";

interface ModelSelectProps {
  agent: AgentName;
  value: string | null;
  onChange: (id: string | null) => void;
  // The project this model launches into; resolves the project-scoped
  // default (rung 3) and the workspace mode Dashboard reads separately.
  projectId: string;
  // The running session's model, carried across a same-agent respawn or
  // handoff (rung 1). null when there is nothing to carry, e.g. a fresh
  // Dashboard spawn.
  carry: CarrySpawnModel | null;
  ariaLabel?: string;
}

function favoriteKey(agent: AgentName, id: string): string {
  return `${agent}:${id}`;
}

export function ModelSelect({
  agent,
  value,
  onChange,
  projectId,
  carry,
  ariaLabel = "Model",
}: ModelSelectProps) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<AgentModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const favorites = useFavorites(FAVORITES_STORAGE_KEY);
  const spawnDefaults = useResolvedSpawnDefaults(projectId, agent);
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
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agent]);

  // If the current selection is not part of the freshly loaded list, drop it.
  useEffect(() => {
    if (value !== null && !loading && models.length > 0 && !models.some((m) => m.id === value)) {
      onChangeRef.current(null);
    }
  }, [models, loading, value]);

  const isFavorite = (model: AgentModel) => favorites.has(favoriteKey(agent, model.id));

  // Once both fetches settle, preselect a concrete model instead of leaving
  // the field on a "server decides" sentinel. Only runs while unresolved: the
  // reset above re-enters this by nulling a stale selection, and a resolved
  // id can never be re-nulled by this effect, so the two never loop.
  useEffect(() => {
    if (value !== null || loading || spawnDefaults.loading) return;
    const favoriteIds = new Set(
      models.filter((model) => favorites.has(favoriteKey(agent, model.id))).map((m) => m.id),
    );
    const resolved = resolvePreselectedModelId({
      agent,
      models,
      favoriteIds,
      carry,
      projectDefaultModelId: spawnDefaults.model,
    });
    if (resolved !== null) onChangeRef.current(resolved);
  }, [
    value,
    loading,
    spawnDefaults.loading,
    spawnDefaults.model,
    models,
    favorites.keys,
    agent,
    carry?.agent,
    carry?.model,
  ]);

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

  // value stays null both while a fetch is in flight and once resolution
  // settles with an empty list (nothing to preselect); the label
  // distinguishes those two rather than showing a placeholder sentinel.
  const settled = !loading && !spawnDefaults.loading;
  const selectedLabel =
    value !== null
      ? (models.find((m) => m.id === value)?.label ?? value)
      : settled
        ? "No models"
        : "Resolving…";

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
            {loading ? (
              <div className="px-2 py-2 text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-tertiary)]">
                Loading…
              </div>
            ) : error ? (
              <div className="px-2 py-2 text-[10px] uppercase tracking-[0.1em] text-[var(--color-status-error)]">
                {error}
              </div>
            ) : orderedModels.length === 0 ? (
              <div className="px-2 py-2 text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-tertiary)]">
                No models
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
                        setOpen(false);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <span className="block truncate font-bold" title={model.label}>
                        {model.label}
                        {model.isDefault ? (
                          <span className="ml-1 text-[10px] font-normal text-[var(--color-text-tertiary)]">
                            (default)
                          </span>
                        ) : null}
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
