"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FavoriteIcon } from "@/components/icons/FavoriteIcon";
import { Skeleton } from "@/components/Skeleton";
import { INPUT_CLASS } from "@/design/classes";
import { useAnchoredMenu } from "@/hooks/useAnchoredMenu";
import { useFavorites } from "@/hooks/useFavorites";
import { cn } from "@/lib/cn";
import type { AgentName } from "@/lib/agents";
import {
  resolvePreselectedModelId,
  type CarrySpawnModel,
  type ResolvedSpawnDefaults,
} from "@/lib/spawn-defaults";
import type { AgentModel, AgentModelsResponse } from "@/lib/types";

const FAVORITES_STORAGE_KEY = "spur:model-favorites";

interface ModelSelectProps {
  agent: AgentName;
  value: string | null;
  onChange: (id: string | null) => void;
  // The project-scoped resolved defaults (model rung 3, and the workspace
  // mode the owning component reads separately). Fetched once by the owning
  // component (via useResolvedSpawnDefaults) and passed down, so a modal
  // with both a ModelSelect and its own workspace-mode UI issues exactly one
  // request instead of two racing copies of the same answer.
  spawnDefaults: ResolvedSpawnDefaults;
  // The running session's model, carried across a same-agent respawn or
  // handoff (rung 1). null when there is nothing to carry, e.g. a fresh
  // Dashboard spawn.
  carry: CarrySpawnModel | null;
  // Fires whenever the model is/isn't submittable, and with what error (if
  // any) to show. `resolved` is true once both the model list and the
  // project-scoped defaults have settled AND the model list did not error —
  // a settled-EMPTY catalog is a valid, submittable state with `value`
  // staying null, but a settled-ERRORED one is not: it stays unresolved
  // (blocking submit) the same way an unresolved workspace-mode default
  // does, rather than silently proceeding as if the catalog were just
  // empty. `error` is this control's own model-fetch failure message (not
  // the caller's separate spawn-defaults error); the caller surfaces it
  // wherever it already surfaces that one, so both fetches share one error
  // presentation instead of two different ones. Never true early just
  // because `value` is already non-null: a caller-seeded value (e.g. a
  // carried session model) still needs the settled catalog to confirm it
  // through `carry`'s isListed() filter.
  onResolvedChange: (resolved: boolean, error: string | null) => void;
  ariaLabel?: string;
}

function favoriteKey(agent: AgentName, id: string): string {
  return `${agent}:${id}`;
}

export function ModelSelect({
  agent,
  value,
  onChange,
  spawnDefaults,
  carry,
  onResolvedChange,
  ariaLabel = "Model",
}: ModelSelectProps) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<AgentModel[]>([]);
  // Starts true: the mount effect below always kicks off a fetch for the
  // current agent, so the pre-effect render must not read as settled.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const favorites = useFavorites(FAVORITES_STORAGE_KEY);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onResolvedChangeRef = useRef(onResolvedChange);
  onResolvedChangeRef.current = onResolvedChange;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Backstop above the server-side 8s spurRequest timeout (packages/web/
    // src/app/api/models/route.ts): that bound should always resolve this
    // first, but a client-side ceiling means a stalled request settles into
    // the error state — never an indefinite disable — even if that upstream
    // bound is ever bypassed or missing.
    void fetch(`/api/models?agent=${encodeURIComponent(agent)}`, {
      signal: AbortSignal.timeout(12_000),
    })
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

  // value stays null both while a fetch is in flight and once resolution
  // settles with an empty list (nothing to preselect); the label
  // distinguishes those two rather than showing a placeholder sentinel.
  const settled = !loading && !spawnDefaults.loading;
  // Resolved is "settled and the model list didn't error": every rung of
  // the precedence chain, including a carried session model (rung 1), must
  // clear the isListed() filter inside resolvePreselectedModelId before a
  // value counts as submittable. A caller must never seed `value` directly
  // from an unfiltered source (e.g. session.model) to fast-path this — that
  // would let a model that has since left the catalog stay selected and
  // submittable ahead of the fetch that would have caught it. A model-fetch
  // error is treated like an unresolved workspace-mode default, not like a
  // genuinely empty catalog: it keeps blocking submit instead of settling
  // into "enabled, model omitted".
  const resolved = settled && error === null;

  useEffect(() => {
    onResolvedChangeRef.current(resolved, error);
  }, [resolved, error]);

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

  // null while unresolved: the button renders a motion-only Skeleton for
  // that case instead of a visible wait-text label like "Resolving…". A
  // settled error reads distinctly from a settled-but-genuinely-empty
  // catalog — both leave `value` null, but they are not the same fact.
  const selectedLabel =
    value !== null
      ? (models.find((m) => m.id === value)?.label ?? value)
      : settled
        ? error !== null
          ? "Model list unavailable"
          : "No models"
        : null;

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
        <span className="truncate">
          {selectedLabel !== null ? (
            selectedLabel
          ) : (
            <Skeleton className="h-3 w-16" label="Resolving model" />
          )}
        </span>
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
              <div className="px-2 py-2">
                <Skeleton className="h-4 w-28" label="Loading models" />
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
                          // The agent's own catalog default (e.g. Claude's
                          // default model), not the value the precedence
                          // chain above preselects — a different row can be
                          // the actual selection. Worded so it never reads
                          // as "the default choice" for this control.
                          <span className="ml-1 text-[10px] font-normal text-[var(--color-text-tertiary)]">
                            (catalog default)
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
