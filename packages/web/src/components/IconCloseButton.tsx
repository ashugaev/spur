"use client";

import { CloseIcon } from "@/components/icons/CloseIcon";
import { ICON_BUTTON_CLASS } from "@/design/classes";

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
      className={`${ICON_BUTTON_CLASS} h-8 w-8 ${idleTextClass}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <CloseIcon className="h-3.5 w-3.5" strokeWidth={2} />
    </button>
  );
}
