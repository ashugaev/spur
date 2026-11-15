"use client";

import { CloseIcon } from "@/components/icons/CloseIcon";

export function IconCloseButton({
  label,
  onClick,
  disabled = false,
  idleTextClass = "text-[var(--color-text-tertiary)]",
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  idleTextClass?: string;
}) {
  return (
    <button
      aria-label={label}
      className={`inline-flex h-8 w-8 items-center justify-center border border-[var(--color-border-strong)] ${idleTextClass} transition hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-50`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <CloseIcon className="h-3.5 w-3.5" strokeWidth={2} />
    </button>
  );
}
