"use client";

import type { ReactNode } from "react";

// Generic icon button, classes copied from IconCloseButton — that component
// is hard-wired to CloseIcon, so a second per-row control (send-now, etc.)
// takes its icon as a child instead of duplicating the class string.
// aria-busy / the busyLabel swap follow the same pattern as every other
// busyAction-driven control in SessionDetail.tsx (pause, restore, reopen,
// handoff): a sighted user sees the spinner in place of the icon, a
// screen-reader user needs the busy state and the in-progress label
// announced too, not just the icon swap.
export function IconActionButton({
  label,
  busyLabel,
  busy = false,
  onClick,
  disabled = false,
  children,
}: {
  label: string;
  busyLabel?: string;
  busy?: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      aria-busy={busy || undefined}
      aria-label={busy && busyLabel ? busyLabel : label}
      className="inline-flex h-8 w-8 items-center justify-center border border-[var(--color-border-strong)] text-[var(--color-text-tertiary)] transition hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}
