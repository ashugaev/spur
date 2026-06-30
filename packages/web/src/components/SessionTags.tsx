"use client";

import { useMemo, useState } from "react";
import { useTags } from "@/components/TagsContext";
import type { DashboardSession } from "@/lib/types";

// Cap chips shown on a dense single-line row so many tags never push the
// activity time / action button off-screen; the rest collapse into a +N chip.
const MAX_VISIBLE_TAGS = 4;

function tagChipStyle(color: string): React.CSSProperties {
  return {
    color,
    borderColor: `color-mix(in srgb, ${color} 55%, transparent)`,
    background: `color-mix(in srgb, ${color} 10%, transparent)`,
  };
}

export function SessionTags({ session }: { session: DashboardSession }) {
  const { catalog, applyTags } = useTags();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const colorByName = useMemo(
    () => new Map(catalog.map((tag) => [tag.name, tag.color] as const)),
    [catalog],
  );
  const applied = session.tags ?? [];
  const available = useMemo(
    () => catalog.filter((tag) => !applied.includes(tag.name)),
    [catalog, applied],
  );
  const canAdd = catalog.length > 0 && available.length > 0;

  async function change(add: string[], remove: string[]) {
    if (busy) return;
    setBusy(true);
    setOpen(false);
    try {
      await applyTags(session.id, { add, remove });
    } catch (err) {
      console.error("tag update failed", err);
    } finally {
      setBusy(false);
    }
  }

  const visible = applied.slice(0, MAX_VISIBLE_TAGS);
  const overflow = applied.slice(MAX_VISIBLE_TAGS);

  return (
    <span className="relative hidden shrink-0 items-center gap-1 sm:inline-flex">
      {visible.map((name) => {
        const color = colorByName.get(name) ?? "var(--color-text-tertiary)";
        return (
          <span
            key={name}
            className="group/tag inline-flex items-center gap-1 border p-1 text-[9px] uppercase leading-none tracking-[0.08em]"
            style={tagChipStyle(color)}
          >
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: color }}
            />
            <span>{name}</span>
            <button
              aria-label={`Remove tag ${name}`}
              className="shrink-0 opacity-0 transition group-hover/tag:opacity-100"
              disabled={busy}
              onClick={() => change([], [name])}
              type="button"
            >
              ×
            </button>
          </span>
        );
      })}

      {overflow.length > 0 ? (
        <span
          className="inline-flex items-center border border-[var(--color-border-subtle)] p-1 text-[9px] uppercase leading-none tracking-[0.08em] text-[var(--color-text-tertiary)]"
          title={overflow.join(", ")}
        >
          +{overflow.length}
        </span>
      ) : null}

      {canAdd ? (
        <button
          aria-label="Add tag"
          className={`inline-flex h-5 w-5 items-center justify-center border border-[var(--color-border-subtle)] text-[var(--color-text-tertiary)] transition hover:border-[var(--color-border-default)] hover:text-[var(--color-text-secondary)] ${
            open || applied.length > 0 ? "opacity-60" : "opacity-0 group-hover:opacity-100"
          }`}
          disabled={busy}
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          <svg
            aria-hidden="true"
            className="h-2.5 w-2.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            viewBox="0 0 24 24"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      ) : null}

      {open ? (
        <>
          <button
            aria-hidden="true"
            className="fixed inset-0 z-20 cursor-default"
            onClick={() => setOpen(false)}
            tabIndex={-1}
            type="button"
          />
          <div className="absolute right-0 top-5 z-30 w-56 border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] py-1 shadow-lg">
            {available.map((tag) => (
              <button
                key={tag.name}
                className="block w-full px-2 py-1.5 text-left transition hover:bg-[var(--color-hover-overlay)]"
                onClick={() => change([tag.name], [])}
                type="button"
              >
                <span
                  className="inline-flex items-center gap-1.5 text-[9px] uppercase tracking-[0.08em]"
                  style={{ color: tag.color }}
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: tag.color }}
                  />
                  {tag.name}
                </span>
                <span className="mt-0.5 block text-[10px] leading-snug text-[var(--color-text-tertiary)]">
                  {tag.description}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </span>
  );
}
