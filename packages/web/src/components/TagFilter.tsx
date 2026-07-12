"use client";

import { useState } from "react";
import { CHIP_CLASS, tagChipStyle } from "@/lib/tag-style";
import type { SpurTagDefinition } from "@/lib/types";

interface TagFilterProps {
  catalog: SpurTagDefinition[];
  value: string[];
  onChange: (tags: string[]) => void;
}

function triggerLabel(value: string[]): string {
  if (value.length === 0) return "Tags";
  if (value.length <= 2) return value.join(", ");
  return `${value.length} tags`;
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      className="ml-auto h-3.5 w-3.5 text-[var(--color-accent)]"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      viewBox="0 0 24 24"
    >
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

export function TagFilter({ catalog, value, onChange }: TagFilterProps) {
  const [open, setOpen] = useState(false);
  const active = value.length > 0;

  function toggle(tag: string) {
    onChange(value.includes(tag) ? value.filter((name) => name !== tag) : [...value, tag]);
  }

  return (
    <div className="relative inline-flex shrink-0">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={active ? `Filter by tag: ${triggerLabel(value)}` : "Filter by tag"}
        className={`flex items-center gap-1.5 border px-2 py-1.5 uppercase transition ${
          active
            ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10"
            : "border-[var(--color-border-default)] bg-[var(--color-bg-surface)] hover:border-[var(--color-text-tertiary)]"
        }`}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {active ? null : (
          <svg
            aria-hidden="true"
            className="h-3.5 w-3.5 text-[var(--color-text-tertiary)]"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            viewBox="0 0 24 24"
          >
            <path d="M3 5h18M6 12h12M10 19h4" />
          </svg>
        )}
        <span className="max-w-[9rem] truncate text-[var(--color-text-primary)]">
          {triggerLabel(value)}
        </span>
        <svg
          aria-hidden="true"
          className="h-3 w-3 text-[var(--color-text-tertiary)]"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open ? (
        <>
          <button
            aria-hidden="true"
            className="fixed inset-0 z-20 cursor-default"
            onClick={() => setOpen(false)}
            tabIndex={-1}
            type="button"
          />
          <div className="absolute left-0 top-full z-30 mt-1 max-h-72 w-44 overflow-y-auto border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] py-1 shadow-lg">
            <button
              aria-pressed={!active}
              className={`flex w-full items-center px-2 py-1.5 text-left text-[10px] uppercase tracking-[0.08em] transition hover:bg-[var(--color-hover-overlay)] ${
                active
                  ? "text-[var(--color-text-secondary)]"
                  : "bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]"
              }`}
              onClick={() => {
                onChange([]);
                setOpen(false);
              }}
              type="button"
            >
              All tags
              {active ? null : <CheckIcon />}
            </button>
            {catalog.map((tag) => {
              const selected = value.includes(tag.name);
              return (
                <button
                  key={tag.name}
                  aria-pressed={selected}
                  className={`flex w-full items-center gap-1.5 px-2 py-1.5 text-left transition hover:bg-[var(--color-hover-overlay)] ${
                    selected ? "bg-[var(--color-accent)]/10" : ""
                  }`}
                  onClick={() => toggle(tag.name)}
                  type="button"
                >
                  <span className={CHIP_CLASS} style={tagChipStyle(tag.color)}>
                    {tag.name}
                  </span>
                  {selected ? <CheckIcon /> : null}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
