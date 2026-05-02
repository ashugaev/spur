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

export function SlashSuggestions({
  buttonClassName,
  endpoint,
  emptyLabel = "No slash suggestions",
  onSelect,
}: SlashSuggestionsProps) {
  const [open, setOpen] = useState(false);
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
      const width = Math.min(menuRect.width, window.innerWidth - margin * 2);
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
  }, [open, loading, error, suggestions]);

  const sections = [
    { label: "Commands", items: suggestions?.commands ?? [] },
    { label: "Skills", items: suggestions?.skills ?? [] },
    { label: "Agents", items: suggestions?.agents ?? [] },
  ].filter((section) => section.items.length > 0);

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
          className="fixed z-20 flex max-h-80 w-[min(20rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] flex-col overflow-y-auto border border-[var(--color-border-strong)] bg-[var(--color-bg-base)] p-1 shadow-[0_8px_30px_var(--color-shadow-menu)] sm:min-w-[18rem] sm:w-auto"
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
                {section.items.map((item) => (
                  <button
                    className="grid w-full grid-cols-[1fr_auto] gap-x-3 border-b border-[var(--color-border-subtle)] px-2 py-2 text-left transition last:border-b-0 hover:bg-[var(--color-hover-overlay)]"
                    key={item.id}
                    onClick={() => {
                      onSelect(item);
                      setOpen(false);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-bold text-[var(--color-text-primary)]">
                        {item.label}
                      </span>
                      <span className="block text-[10px] text-[var(--color-text-secondary)]">
                        {item.detail}
                      </span>
                    </span>
                    <span className="self-start text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                      {item.source}
                    </span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
