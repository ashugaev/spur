"use client";

import type { ReactNode } from "react";

// Generic icon button, classes copied from IconCloseButton — that component
// is hard-wired to CloseIcon, so a second per-row control (send-now, etc.)
// takes its icon as a child instead of duplicating the class string.
export function IconActionButton({
  label,
  onClick,
  disabled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      className="inline-flex h-8 w-8 items-center justify-center border border-[var(--color-border-strong)] text-[var(--color-text-tertiary)] transition hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}
