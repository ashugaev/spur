"use client";

import { useState } from "react";
import type { SpurTagDefinition } from "@/lib/types";

interface TagFilterProps {
  catalog: SpurTagDefinition[];
  value: string | null;
  onChange: (tag: string | null) => void;
}

export function TagFilter({ catalog, value, onChange }: TagFilterProps) {
  const [open, setOpen] = useState(false);
  const active = value ? (catalog.find((tag) => tag.name === value) ?? null) : null;

  function pick(tag: string | null) {
    onChange(tag);
    setOpen(false);
  }

  return (
    <div className="relative inline-flex shrink-0">
      <button
        aria-label="Filter by tag"
        className={`flex items-center gap-1.5 border px-2 py-1.5 uppercase transition ${
          active
            ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10"
            : "border-[var(--color-border-default)] bg-[var(--color-bg-surface)] hover:border-[var(--color-text-tertiary)]"
        }`}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {active ? (
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: active.color }}
            aria-hidden="true"
          />
        ) : (
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
        <span className="text-[var(--color-text-primary)]">{active ? active.name : "Tags"}</span>
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
              className={`block w-full px-2 py-1.5 text-left text-[10px] uppercase tracking-[0.08em] transition hover:bg-[var(--color-hover-overlay)] ${
                active ? "text-[var(--color-text-secondary)]" : "text-[var(--color-text-primary)]"
              }`}
              onClick={() => pick(null)}
              type="button"
            >
              All tags
            </button>
            {catalog.map((tag) => (
              <button
                key={tag.name}
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[10px] uppercase tracking-[0.08em] transition hover:bg-[var(--color-hover-overlay)]"
                onClick={() => pick(tag.name)}
                type="button"
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: tag.color }}
                  aria-hidden="true"
                />
                <span style={{ color: tag.color }}>{tag.name}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
