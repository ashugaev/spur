"use client";

import { TerminalIcon } from "@/components/icons/TerminalIcon";

const TONE_CLASS = {
  neutral:
    "h-8 w-8 border-[var(--color-border-strong)] text-[var(--color-text-secondary)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text-primary)]",
  error:
    "h-[26px] w-[26px] border-[var(--color-chip-error-border)] text-[var(--color-chip-error-text)] hover:bg-[var(--color-hover-overlay)]",
} as const;

/** Square icon button that hands a sign-in to a native terminal. */
export function TerminalIconButton({
  onClick,
  disabled = false,
  tone = "neutral",
  label = "Continue in terminal",
}: {
  onClick: () => void;
  disabled?: boolean;
  tone?: keyof typeof TONE_CLASS;
  label?: string;
}) {
  return (
    <button
      aria-label={label}
      className={`inline-flex shrink-0 items-center justify-center border outline-none transition focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50 ${TONE_CLASS[tone]}`}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      <TerminalIcon />
    </button>
  );
}
