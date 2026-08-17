"use client";

import { useState } from "react";
import { FavoriteIcon } from "@/components/icons/FavoriteIcon";
import { Skeleton } from "@/components/Skeleton";
import { INPUT_CLASS } from "@/design/classes";
import { useAnchoredMenu } from "@/hooks/useAnchoredMenu";
import { useFavorites } from "@/hooks/useFavorites";
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

function favoriteKeyForEntry(entry: AgentSuggestionEntry): string {
  return [entry.kind, entry.source, entry.id].join(":");
}

export function SlashSuggestions({
  buttonClassName,
  endpoint,
  emptyLabel = "No slash suggestions",
  onSelect,
}: SlashSuggestionsProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const favorites = useFavorites(FAVORITES_STORAGE_KEY);
  const { data: suggestions, error, loading } = useSlashSuggestions({ endpoint, enabled: open });

  const isFavorite = (item: AgentSuggestionEntry) => favorites.has(favoriteKeyForEntry(item));
  const needle = query.trim().toLowerCase();
  const matchesQuery = (item: AgentSuggestionEntry) =>
    needle === "" ||
    item.label.toLowerCase().includes(needle) ||
    item.detail.toLowerCase().includes(needle) ||
    item.id.toLowerCase().includes(needle);
  const baseSections = [
    { label: "Commands", items: (suggestions?.commands ?? []).filter(matchesQuery) },
    { label: "Skills", items: (suggestions?.skills ?? []).filter(matchesQuery) },
    { label: "Agents", items: (suggestions?.agents ?? []).filter(matchesQuery) },
  ];
  const favoriteItems = baseSections.flatMap((section) => section.items.filter(isFavorite));
  const sections = [
    { label: "Favorites", items: favoriteItems },
    ...baseSections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => !isFavorite(item)),
      }))
      .filter((section) => section.items.length > 0),
  ].filter((section) => section.items.length > 0);

  const { containerRef, buttonRef, menuRef, menuStyle } = useAnchoredMenu({
    open,
    onClose: () => setOpen(false),
    contentDeps: [loading, error, suggestions, favorites.keys, query],
  });

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
          className="fixed z-20 flex max-h-80 w-max min-w-[min(20rem,calc(100vw-1rem))] max-w-[calc(100vw-1rem)] flex-col overflow-hidden border border-[var(--color-border-strong)] bg-[var(--color-bg-base)] p-1 shadow-[0_8px_30px_var(--color-shadow-menu)]"
          ref={menuRef}
          role="menu"
          style={menuStyle}
        >
          <input
            aria-label="Search commands"
            autoFocus
            className={cn(INPUT_CLASS, "m-1")}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search commands"
            type="text"
            value={query}
          />
          <div className="flex flex-col overflow-y-auto overflow-x-hidden">
            {loading ? (
              <div className="px-2 py-2">
                <Skeleton className="h-4 w-36" label="Loading suggestions" />
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
                    const favorite = favorites.has(favoriteKey);
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
                            favorites.toggle(favoriteKey);
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
        </div>
      ) : null}
    </div>
  );
}
