"use client";

import { useMemo, useState } from "react";
import { useTags } from "@/components/TagsContext";
import { useAnchoredMenu } from "@/hooks/useAnchoredMenu";
import { tagChipStyle } from "@/lib/tag-style";
import type { DashboardSession } from "@/lib/types";

export type TagEditorVariant = "dots" | "chips";

interface TagEditorProps {
  session: Pick<DashboardSession, "id" | "tags">;
  variant: TagEditorVariant;
}

// Show at most this many dots before collapsing the rest into a "+N" indicator
// so a heavily tagged session never widens the dashboard row.
const MAX_DOTS = 4;

const CHIP_CLASS =
  "inline-flex items-center border p-1.5 text-[9px] uppercase leading-none tracking-[0.06em]";

function PlusIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-2.5 w-2.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function TagEditor({ session, variant }: TagEditorProps) {
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

  const { containerRef, buttonRef, menuRef, menuStyle } = useAnchoredMenu({
    open,
    onClose: () => setOpen(false),
    contentDeps: [applied.length, available.length],
  });

  async function change(add: string[], remove: string[]) {
    if (busy) return;
    setBusy(true);
    setOpen(false);
    try {
      await applyTags(session.id, { add, remove });
    } finally {
      setBusy(false);
    }
  }

  function colorFor(name: string): string {
    return colorByName.get(name) ?? "var(--color-text-tertiary)";
  }

  const visibleDots = applied.slice(0, MAX_DOTS);
  const overflow = applied.length - visibleDots.length;

  const popover = open ? (
    <div
      aria-label="Tag options"
      className="fixed z-30 w-56 border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] py-1 shadow-[0_8px_30px_var(--color-shadow-menu)]"
      ref={menuRef}
      role="menu"
      style={menuStyle}
    >
      {applied.length > 0 ? (
        <div className="border-b border-[var(--color-border-subtle)] px-2 py-1.5">
          <div className="flex flex-wrap gap-1">
            {applied.map((name) => (
              <span className={CHIP_CLASS} key={name} style={tagChipStyle(colorFor(name))}>
                {name}
                <button
                  aria-label={`Remove tag ${name}`}
                  className="ml-1 shrink-0 leading-none"
                  disabled={busy}
                  onClick={() => change([], [name])}
                  type="button"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {available.length > 0 ? (
        available.map((tag) => (
          <button
            className="block w-full px-2 py-1.5 text-left transition hover:bg-[var(--color-hover-overlay)]"
            disabled={busy}
            key={tag.name}
            onClick={() => change([tag.name], [])}
            role="menuitem"
            type="button"
          >
            <span className="text-[9px] uppercase tracking-[0.06em]" style={{ color: tag.color }}>
              {tag.name}
            </span>
            <span className="mt-0.5 block text-[10px] leading-snug text-[var(--color-text-tertiary)]">
              {tag.description}
            </span>
          </button>
        ))
      ) : applied.length === 0 ? (
        <div className="px-2 py-1.5 text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-tertiary)]">
          No tags
        </div>
      ) : null}
    </div>
  ) : null;

  if (variant === "chips") {
    return (
      <div className="relative inline-flex items-center gap-1" ref={containerRef}>
        {applied.map((name) => (
          <span className={CHIP_CLASS} key={name} style={tagChipStyle(colorFor(name))}>
            {name}
          </span>
        ))}
        <button
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label="Manage tags"
          className="inline-flex h-5 items-center gap-1 border border-[var(--color-border-subtle)] px-1.5 text-[9px] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)] transition hover:border-[var(--color-border-default)] hover:text-[var(--color-text-secondary)]"
          disabled={busy}
          onClick={() => setOpen((value) => !value)}
          ref={buttonRef}
          type="button"
        >
          <PlusIcon />
          Tag
        </button>
        {popover}
      </div>
    );
  }

  // Hide the dot cluster below the sm breakpoint: the dense dashboard row has no
  // room for it on narrow/mobile viewports. The chips variant (detail view) stays
  // visible at all widths because that layout has space.
  return (
    <div className="relative hidden shrink-0 items-center sm:inline-flex" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Manage tags"
        className="inline-flex items-center text-[var(--color-text-tertiary)] transition hover:text-[var(--color-text-secondary)]"
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
        ref={buttonRef}
        type="button"
      >
        {applied.length === 0 ? (
          <span className="inline-flex h-4 w-4 items-center justify-center border border-[var(--color-border-subtle)]">
            <PlusIcon />
          </span>
        ) : (
          <span className="inline-flex items-center">
            {visibleDots.map((name, index) => (
              <span
                className={`inline-block h-2.5 w-2.5 rounded-full border border-[var(--color-border-default)] ${
                  index === 0 ? "" : "-ml-1"
                }`}
                key={name}
                style={{ background: colorFor(name) }}
                title={name}
              />
            ))}
            {overflow > 0 ? (
              <span
                className="-ml-1 inline-flex h-2.5 items-center justify-center rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-1 text-[8px] leading-none text-[var(--color-text-tertiary)]"
                title={applied.slice(MAX_DOTS).join(", ")}
              >
                +{overflow}
              </span>
            ) : null}
          </span>
        )}
      </button>
      {popover}
    </div>
  );
}
