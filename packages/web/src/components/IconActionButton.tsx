"use client";

import type { ReactNode } from "react";
import { ICON_BUTTON_CLASS } from "@/design/classes";

// Generic icon button on the shared ICON_BUTTON_CLASS recipe; takes its icon
// as a child (send-now, etc.) where IconCloseButton is wired to CloseIcon.
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
      className={`${ICON_BUTTON_CLASS} h-8 w-8 text-[var(--color-text-tertiary)]`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}
