"use client";

import type { ReactNode } from "react";
import { type StatusTone, toneBorder, toneColor } from "@/design/tone";

export function Zone({
  label,
  tone,
  count,
  collapsed,
  onToggle,
  children,
}: {
  label: string;
  // "accent" marks a non-status section (Pages).
  tone: StatusTone | "accent";
  count: number;
  collapsed?: boolean;
  onToggle?: () => void;
  children: ReactNode;
}) {
  const dot = tone === "accent" ? "var(--color-accent)" : toneColor(tone);
  const rule = tone === "accent" ? "var(--color-border-default)" : toneBorder(tone);
  const header = (
    <div className="flex items-center gap-2 py-2">
      <span className="h-2 w-2 shrink-0 rounded-dot" style={{ background: dot }} />
      <span className="text-label font-bold uppercase tracking-caps text-[var(--color-text-secondary)]">
        {label}
      </span>
      <div className="flex-1 border-t" style={{ borderColor: rule }} />
      <span className="text-label text-[var(--color-text-tertiary)]">{count}</span>
    </div>
  );

  if (typeof onToggle === "function") {
    return (
      <section>
        <button type="button" className="flex w-full items-center text-left" onClick={onToggle}>
          <div className="flex-1">{header}</div>
          <span className="ml-2 text-label text-[var(--color-text-tertiary)]">
            {collapsed ? "▸" : "▾"}
          </span>
        </button>
        {!collapsed ? children : null}
      </section>
    );
  }

  return (
    <section>
      {header}
      {children}
    </section>
  );
}
