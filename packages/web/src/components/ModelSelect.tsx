"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { INPUT_CLASS } from "@/design/classes";
import { cn } from "@/lib/cn";
import type { AgentName } from "@/lib/agents";
import type { AgentModel, AgentModelsResponse } from "@/lib/types";

const FAVORITES_STORAGE_KEY = "spur:model-favorites";

interface ModelSelectProps {
  agent: AgentName;
  value: string | null;
  onChange: (id: string | null) => void;
  ariaLabel?: string;
}

function favoriteKey(agent: AgentName, id: string): string {
  return `${agent}:${id}`;
}

function readFavoriteKeys(): Set<string> {
  if (typeof window === "undefined") return new Set();
  const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? new Set(parsed)
      : new Set();
  } catch {
    return new Set();
  }
}

function writeFavoriteKeys(keys: ReadonlySet<string>) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...keys].sort()));
}

function FavoriteIcon({ active }: { active: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className="h-3 w-3"
      fill={active ? "currentColor" : "none"}
      viewBox="0 0 24 24"
    >
      <path
        d="m12 3 2.8 5.67 6.25.91-4.52 4.41 1.07 6.23L12 17.28l-5.6 2.94 1.07-6.23-4.52-4.41 6.25-.91L12 3Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

export function ModelSelect({ agent, value, onChange, ariaLabel = "Model" }: ModelSelectProps) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<AgentModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [favoriteKeys, setFavoriteKeys] = useState<Set<string>>(() => readFavoriteKeys());
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | undefined>(undefined);
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

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!open) return;
      if (containerRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (open && event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === FAVORITES_STORAGE_KEY) setFavoriteKeys(readFavoriteKeys());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const isFavorite = (model: AgentModel) => favoriteKeys.has(favoriteKey(agent, model.id));

  const orderedModels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? models.filter(
          (m) => m.id.toLowerCase().includes(needle) || m.label.toLowerCase().includes(needle),
        )
      : models;
    const favorites = filtered.filter(isFavorite);
    const rest = filtered.filter((m) => !isFavorite(m));
    return [...favorites, ...rest];
  }, [models, query, favoriteKeys, agent]);

  useLayoutEffect(() => {
    if (!open) {
      setMenuStyle(undefined);
      return;
    }
    const updateMenuPosition = () => {
      const button = buttonRef.current;
      const menu = menuRef.current;
      if (!button || !menu) return;
      const margin = 8;
      const buttonRect = button.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const width = Math.min(
        Math.max(menuRect.width, Math.min(menu.scrollWidth, window.innerWidth - margin * 2)),
        window.innerWidth - margin * 2,
      );
      const left = Math.min(
        Math.max(margin, buttonRect.left),
        Math.max(margin, window.innerWidth - width - margin),
      );
      const aboveTop = buttonRect.top - menuRect.height - margin;
      const belowTop = buttonRect.bottom + margin;
      const top =
        aboveTop >= margin
          ? aboveTop
          : Math.max(margin, Math.min(belowTop, window.innerHeight - menuRect.height - margin));
      setMenuStyle({ left: `${left}px`, top: `${top}px`, width: `${width}px` });
    };
    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, loading, error, orderedModels]);

  const toggleFavorite = (model: AgentModel) => {
    setFavoriteKeys((current) => {
      const key = favoriteKey(agent, model.id);
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      writeFavoriteKeys(next);
      return next;
    });
  };

  const selectedLabel =
    value === null ? "Default" : (models.find((m) => m.id === value)?.label ?? value);

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
            className={cn(INPUT_CLASS, "m-1 text-xs")}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models"
            type="text"
            value={query}
          />
          <div className="flex flex-col overflow-y-auto overflow-x-hidden">
            <button
              className={cn(
                "flex w-full items-center border-b border-[var(--color-border-subtle)] px-2 py-2 text-left transition hover:bg-[var(--color-hover-overlay)]",
                value === null ? "text-[var(--color-accent)]" : "text-[var(--color-text-primary)]",
              )}
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              role="menuitem"
              type="button"
            >
              <span className="font-bold">Default</span>
            </button>
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
                        toggleFavorite(model);
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
