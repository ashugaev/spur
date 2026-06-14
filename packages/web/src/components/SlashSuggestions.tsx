"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useSlashSuggestions } from "@/hooks/useSlashSuggestions";
import { cn } from "@/lib/cn";
import type { AgentSuggestionEntry } from "@/lib/types";

interface SlashSuggestionsProps {
  buttonClassName?: string;
  endpoint: string | null;
  emptyLabel?: string;
  onSelect: (entry: AgentSuggestionEntry) => void;
}

const FAVORITES_STORAGE_KEY = "spur:slash-suggestion-favorites";

interface SlashSuggestionSection {
  label: string;
  items: AgentSuggestionEntry[];
}

function favoriteKeyForEntry(entry: AgentSuggestionEntry): string {
  return [entry.kind, entry.source, entry.id].join(":");
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

export function SlashSuggestions({
  buttonClassName,
  endpoint,
  emptyLabel = "No slash suggestions",
  onSelect,
}: SlashSuggestionsProps) {
  const [open, setOpen] = useState(false);
  const [favoriteKeys, setFavoriteKeys] = useState<Set<string>>(() => readFavoriteKeys());
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | undefined>(undefined);
  const { data: suggestions, error, loading } = useSlashSuggestions({ endpoint, enabled: open });

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!open) return;
      if (containerRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (open && event.key === "Escape") {
        setOpen(false);
      }
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
      if (event.key === FAVORITES_STORAGE_KEY) {
        setFavoriteKeys(readFavoriteKeys());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
    };
  }, []);

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

      setMenuStyle({
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
      });
    };

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, loading, error, suggestions, favoriteKeys]);

  const baseSections: SlashSuggestionSection[] = [
    { label: "Commands", items: suggestions?.commands ?? [] },
    { label: "Skills", items: suggestions?.skills ?? [] },
    { label: "Agents", items: suggestions?.agents ?? [] },
  ];
  const favoriteItems = baseSections.flatMap((section) =>
    section.items.filter((item) => favoriteKeys.has(favoriteKeyForEntry(item))),
  );
  const sections: SlashSuggestionSection[] = [
    ...(favoriteItems.length > 0 ? [{ label: "Favorites", items: favoriteItems }] : []),
    ...baseSections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => !favoriteKeys.has(favoriteKeyForEntry(item))),
      }))
      .filter((section) => section.items.length > 0),
  ];

  const toggleFavorite = (entry: AgentSuggestionEntry) => {
    setFavoriteKeys((current) => {
      const key = favoriteKeyForEntry(entry);
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

  return (
    <div className="relative" ref={containerRef}>
      <button
        aria-label="Slash"
        aria-expanded={open}
        aria-haspopup="menu"
        ref={buttonRef}
        className={cn(
          "border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)]",
          buttonClassName,
        )}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        /
      </button>
      {open ? (
        <div
          aria-label="Slash suggestions"
          className="fixed z-20 flex max-h-80 w-max min-w-[min(20rem,calc(100vw-1rem))] max-w-[calc(100vw-1rem)] flex-col overflow-y-auto overflow-x-hidden border border-[var(--color-border-strong)] bg-[var(--color-bg-base)] p-1 shadow-[0_8px_30px_var(--color-shadow-menu)]"
          ref={menuRef}
          role="menu"
          style={menuStyle}
        >
          {loading ? (
            <div className="px-2 py-2 text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-tertiary)]">
              Loading…
            </div>
          ) : error ? (
            <div className="px-2 py-2 text-[10px] uppercase tracking-[0.1em] text-[var(--color-status-error)]">
              {error}
            </div>
          ) : sections.length === 0 ? (
            <div className="px-2 py-2 text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-tertiary)]">
              {emptyLabel}
            </div>
          ) : (
            sections.map((section) => (
              <div key={section.label}>
                <div className="border-b border-[var(--color-border-subtle)] px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                  {section.label}
                </div>
                {section.items.map((item) => {
                  const favoriteKey = favoriteKeyForEntry(item);
                  const favorite = favoriteKeys.has(favoriteKey);
                  return (
                    <div
                      className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2 border-b border-[var(--color-border-subtle)] last:border-b-0 hover:bg-[var(--color-hover-overlay)]"
                      key={favoriteKey}
                    >
                      <button
                        aria-label={`${favorite ? "Remove favorite" : "Add favorite"} ${item.label}`}
                        aria-pressed={favorite}
                        className={cn(
                          "self-start px-2 py-2 transition",
                          favorite
                            ? "text-[var(--color-status-attention)] hover:text-[var(--color-status-attention)]"
                            : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]",
                        )}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleFavorite(item);
                        }}
                        title={`${favorite ? "Remove favorite" : "Add favorite"} ${item.label}`}
                        type="button"
                      >
                        <FavoriteIcon active={favorite} />
                      </button>
                      <button
                        className="min-w-0 py-2 text-left transition"
                        onClick={() => {
                          onSelect(item);
                          setOpen(false);
                        }}
                        role="menuitem"
                        type="button"
                      >
                        <span
                          className="block truncate font-bold text-[var(--color-text-primary)]"
                          title={item.label}
                        >
                          {item.label}
                        </span>
                        <span
                          className="block truncate text-[10px] text-[var(--color-text-secondary)]"
                          title={item.detail}
                        >
                          {item.detail}
                        </span>
                      </button>
                      <span
                        className="max-w-24 truncate px-2 py-2 text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]"
                        title={item.source}
                      >
                        {item.source}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
