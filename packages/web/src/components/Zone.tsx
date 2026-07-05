"use client";

import type { ReactNode } from "react";

export function Zone({
  label,
  color,
  count,
  dividerColor,
  collapsed,
  onToggle,
  children,
}: {
  label: string;
  color: string;
  count: number;
  dividerColor?: string;
  collapsed?: boolean;
  onToggle?: () => void;
  children: ReactNode;
}) {
  const header = (
    <div className="flex items-center gap-2 py-2">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-secondary)]">
        {label}
      </span>
      <div
        className="flex-1 border-t"
        style={{ borderColor: dividerColor ?? `color-mix(in srgb, ${color} 25%, transparent)` }}
      />
      <span className="text-[10px] text-[var(--color-text-tertiary)]">{count}</span>
    </div>
  );

  if (typeof onToggle === "function") {
    return (
      <section>
        <button type="button" className="flex w-full items-center text-left" onClick={onToggle}>
          <div className="flex-1">{header}</div>
          <span className="ml-2 text-[10px] text-[var(--color-text-tertiary)]">
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
