"use client";

import type { ReactNode } from "react";

export const DATA_ROW_CLASS =
  "data-row group flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-2 py-2 transition-colors sm:gap-3 sm:px-2.5";

export function DataRow({ children }: { children: ReactNode }) {
  return <div className={DATA_ROW_CLASS}>{children}</div>;
}

const BASE_BTN = "inline-flex h-6 w-6 shrink-0 items-center justify-center border transition";
const DISABLED_BTN =
  "border-transparent text-[var(--color-text-tertiary)] opacity-25 cursor-not-allowed";

export function RowIconButton({
  label,
  disabled,
  activeClass,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  activeClass: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      className={`${BASE_BTN} ${disabled ? DISABLED_BTN : activeClass}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}
